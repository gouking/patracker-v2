// BOM / tracker Excel 的匯入（解析 → 預覽差異 → 寫入）與匯出。
//
// 匯入規則：
//   * 依表頭文字對欄位（相容原本的 XT tracker 格式，也吃只有 BOM 欄位的表）
//   * 以 (主料料號, 材料料號) 當同一顆料
//   * BOM 欄位（成品料號、機種、品名、LIFECYCLE…）以檔案為準更新
//   * 屬性、供應商、各日期：只補空白，已經有值的絕不覆蓋——那是各角色在系統裡填的
//   * 檔案裡沒有的料號標記「已不在 BOM」，不刪除；之後再出現就自動恢復

import ExcelJS from "exceljs";
import { db, newId, now, type Db } from "./db";
import { HttpError, getSla, listMembers, requireManage, type Access } from "./projects";
import { listParts, TIMEZONE } from "./parts";
import { FIELDS, HOLD_REASONS, OWNER_ROLE, PHASES, PHASE_BY_KEY, SLA_FIELDS, STAGES, slaColumn, isDate, todayIn, type FieldDef, type Issue, type Part } from "@/lib/pa";
import { BomPdfError, parseBomPdf, type PdfHeader } from "./bomPdf";
import type { PaEvent } from "./notify";

// 以檔案為準的欄位（PDF 專屬的結構欄位也算，但只有解析結果裡有的才會動到）
const BOM_KEYS = [
  "fg_pn", "fg_model", "fg_desc", "main_pn", "lifecycle", "part_desc",
  "bom_level", "parent_pn", "find_num", "alt_of_pn", "qty", "ref_des",
] as const;
const FILL_KEYS = FIELDS.map((f) => f.key).filter((k) => !(BOM_KEYS as readonly string[]).includes(k) && k !== "part_pn");

const ISSUE_HEADERS: Record<Issue["dept"], string[]> = { RD: ["rd", "iteration"], QA: ["qa", "iteration"] };
const NOTE_HEADERS = [["remark"], ["備註"], ["進度"]];

/** remark 一格裡是很多行：「1/19廠商提供」「4/13已審，廠商修正中」。
 *  一行一筆，行首那個日期抓出來；只有月/日的（他們平常就這樣寫）補上年份——
 *  用檔案匯入當天的年份，但如果這樣會變成未來太久，就當成去年的事。 */
export function parseNoteLines(text: string, today: string): { date: string; text: string }[] {
  const out: { date: string; text: string }[] = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const full = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*(.*)$/.exec(line);
    const short = /^(\d{1,2})[-/.](\d{1,2})\s*(.*)$/.exec(line);
    let date = "";
    let body = line;
    if (full) {
      date = `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;
      body = full[4].trim();
    } else if (short) {
      const year = Number(today.slice(0, 4));
      const guess = `${year}-${short[1].padStart(2, "0")}-${short[2].padStart(2, "0")}`;
      // 比今天晚三個月以上，多半是去年的紀錄
      date = guess > addMonths(today, 3) ? `${year - 1}-${guess.slice(5)}` : guess;
      body = short[3].trim();
    } else {
      date = today;
    }
    if (!isDate(date)) date = today;
    out.push({ date, text: body || line });
  }
  return out;
}

function addMonths(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

export interface ParsedRow {
  line: number;
  values: Partial<Record<keyof Part, string | null>>;
  issues: { dept: Issue["dept"]; date: string }[];
  /** remark 欄拆出來的進度紀錄,一行一筆 */
  notes: { date: string; text: string }[];
  /** 同一顆料在別的成品底下又出現一次(主料＋料號撞名,但成品料號不同) */
  dupFg?: boolean;
}

export interface ParseResult {
  source: "excel" | "pdf";
  sheet: string;
  /** PDF 才有：BOM 表頭（最上層組件） */
  header?: PdfHeader;
  /** PDF 才有：這次實際採用的成品機種名稱 */
  fgModel?: string;
  mapped: { column: string; field: string }[];
  ignored: string[];
  rows: ParsedRow[];
  warnings: string[];
}

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("result" in v) return cellText(v.result as ExcelJS.CellValue);
    if ("text" in v) return String(v.text);
    if ("error" in v) return "";
  }
  return String(v);
}

/** 單一日期：Excel 日期格、2026-05-05、2026/5/5、Excel 序號 */
function toDate(v: ExcelJS.CellValue): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object" && v && "result" in v) return toDate(v.result as ExcelJS.CellValue);
  if (typeof v === "number" && v > 20000 && v < 80000) {
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  return datesIn(cellText(v))[0] ?? null;
}

function datesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g)) {
    const d = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    if (isDate(d)) out.push(d);
  }
  return out;
}

function matches(header: string, def: { headers: string[][]; exact?: boolean }, exactOnly: boolean): boolean {
  const h = norm(header);
  return def.headers.some((tokens) =>
    exactOnly || def.exact ? h === norm(tokens.join("")) : tokens.every((t) => h.includes(norm(t)))
  );
}

export async function parseWorkbook(buf: ArrayBuffer, today = todayIn(TIMEZONE)): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch {
    throw new HttpError(400, "讀不到這個檔案，請確認是 .xlsx 格式");
  }

  // 找「有材料料號表頭」的工作表與那一列（前 15 列內）
  const partDef = FIELDS.find((f) => f.key === "part_pn")!;
  let sheet: ExcelJS.Worksheet | null = null;
  let headerRow = 0;
  // 一個檔案可能有好幾張工作表(樞紐表、統計表也會出現「材料料號」之類的字),
  // 挑「表頭對得上最多欄位」的那一張,不是看到第一個就算
  let best = 0;
  for (const ws of wb.worksheets) {
    for (let r = 1; r <= Math.min(15, ws.rowCount); r++) {
      const texts: string[] = [];
      ws.getRow(r).eachCell((c) => texts.push(cellText(c.value)));
      if (!texts.some((t) => matches(t, partDef, false))) continue;
      const score = FIELDS.filter((f) => texts.some((t) => matches(t, f, false))).length;
      if (score > best) {
        best = score;
        sheet = ws;
        headerRow = r;
      }
    }
  }
  if (!sheet) throw new HttpError(400, "找不到「材料料號」欄位的表頭，請確認檔案格式");

  const headers = new Map<number, string>();
  sheet.getRow(headerRow).eachCell((c, col) => {
    const t = cellText(c.value).trim();
    if (t) headers.set(col, t);
  });

  // 先配完全相同的表頭，再配「包含關鍵字」的，避免「供應商」被「通知供應商日期」搶走
  const colOf = new Map<string, number>();
  const used = new Set<number>();
  const defs: (FieldDef | { key: string; headers: string[][]; exact?: boolean })[] = [
    ...FIELDS,
    { key: "issue:RD", headers: [ISSUE_HEADERS.RD] },
    { key: "issue:QA", headers: [ISSUE_HEADERS.QA] },
    { key: "note", headers: NOTE_HEADERS },
  ];
  for (const exactPass of [true, false]) {
    for (const d of defs) {
      if (colOf.has(d.key)) continue;
      for (const [col, text] of headers) {
        if (used.has(col)) continue;
        if (exactPass ? matches(text, { ...d, exact: true }, true) : matches(text, d, false)) {
          colOf.set(d.key, col);
          used.add(col);
          break;
        }
      }
    }
  }

  const warnings: string[] = [];
  const rows: ParsedRow[] = [];
  const seen = new Map<string, number>();
  const partCol = colOf.get("part_pn")!;
  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const pn = cellText(row.getCell(partCol).value).trim();
    if (!pn) continue;
    const values: ParsedRow["values"] = {};
    for (const f of FIELDS) {
      const col = colOf.get(f.key);
      if (!col) continue;
      const v = row.getCell(col).value;
      if (f.kind === "date") {
        const d = toDate(v);
        if (!d && cellText(v).trim()) warnings.push(`第 ${r} 列「${headers.get(col)}」不是日期：${cellText(v).trim()}（略過）`);
        values[f.key] = d;
      } else if (f.kind === "type") {
        const t = cellText(v).trim();
        values[f.key] = t === "標準件" || t === "訂製件" ? t : "";
        if (t && !values[f.key]) warnings.push(`第 ${r} 列屬性「${t}」不是標準件/訂製件（略過）`);
      } else if (f.kind === "hold") {
        const t = cellText(v).trim();
        const hit = HOLD_REASONS.find((h) => h.toLowerCase() === t.toLowerCase());
        values[f.key] = hit ?? "";
        if (t && !hit) warnings.push(`第 ${r} 列卡關原因「${t}」不是 ${HOLD_REASONS.join("／")}（略過）`);
      } else {
        values[f.key] = cellText(v).trim();
      }
    }
    const issues: ParsedRow["issues"] = [];
    for (const dept of ["RD", "QA"] as const) {
      const col = colOf.get(`issue:${dept}`);
      if (!col) continue;
      const v = row.getCell(col).value;
      const ds = v instanceof Date ? [toDate(v)!] : datesIn(cellText(v));
      for (const d of ds) issues.push({ dept, date: d });
    }
    const noteCol = colOf.get("note");
    const notes = noteCol ? parseNoteLines(cellText(row.getCell(noteCol).value), today) : [];
    const key = `${values.main_pn ?? ""} ${pn}`;
    // 同一顆料用在不同成品(例如 Main PCBA 與 Encoder PCBA 都用同一顆電阻,主料又是空白)是兩列,
    // 靠成品料號區分;連成品料號都一樣才算重複
    let dupFg = false;
    if (seen.has(key)) {
      const altKey = `${key}\u0000${values.fg_pn ?? ""}`;
      if (!values.fg_pn || seen.has(altKey)) {
        warnings.push(`第 ${r} 列與第 ${seen.get(key)} 列是同一顆料（主料 ${values.main_pn || "空白"} / ${pn}），只取第一筆`);
        continue;
      }
      seen.set(altKey, r);
      dupFg = true;
    } else {
      seen.set(key, r);
    }
    rows.push({ line: r, values, issues, notes, ...(dupFg ? { dupFg } : {}) });
  }

  const labelOf = (k: string) =>
    FIELDS.find((f) => f.key === k)?.label ??
    (k === "issue:RD" ? "RD 退件紀錄" : k === "issue:QA" ? "QA 退件紀錄" : "進度紀錄");
  return {
    source: "excel",
    sheet: sheet.name,
    mapped: [...colOf].sort((a, b) => a[1] - b[1]).map(([k, col]) => ({ column: headers.get(col)!, field: labelOf(k) })),
    ignored: [...headers].filter(([col]) => !used.has(col)).map(([, t]) => t),
    rows,
    warnings,
  };
}

// ---------- 差異 ----------

export interface Diff {
  added: { part_pn: string; part_desc: string }[];
  changed: { part_pn: string; changes: { field: string; from: string; to: string }[] }[];
  filled: number;
  issuesAdded: number;
  notesAdded: number;
  removed: { part_pn: string; part_desc: string }[];
  restored: { part_pn: string }[];
  /** 新匯入時自動判定為母階組件、不列入追蹤的 */
  autoExcluded: { part_pn: string; part_desc: string }[];
  /** 「發起 PA」原本空白、這次匯入自動填上匯入日的(PM 匯入 BOM 就算發起) */
  autoStarted: number;
}

interface Plan {
  diff: Diff;
  apply: () => Promise<void>;
  /** 自動發起的料:寫入之後要寄「已發起 PA」即時通知給 Sourcer */
  started: string[];
}

async function plan(a: Access, userId: string, parsed: ParseResult): Promise<Plan> {
  const pid = a.project.id;
  const existing = await db.all<Part>("select * from pa_parts where project_id = ? order by sort_order", [pid]);
  // 同一顆料可能出現在不同成品底下:一般用「主料 料號」對,撞名的那幾列再加上成品料號
  const byKey = new Map<string, Part>();
  for (const p of existing) {
    const k = `${p.main_pn} ${p.part_pn}`;
    if (!byKey.has(k)) byKey.set(k, p);
    byKey.set(`${k}\u0000${p.fg_pn}`, p);
  }
  const existingNotes = new Set(
    (
      await db.all<{ part_id: string; date: string; text: string }>(
        "select n.part_id, n.date, n.text from pa_part_notes n join pa_parts p on p.id = n.part_id where p.project_id = ?",
        [pid]
      )
    ).map((n) => `${n.part_id}|${n.date}|${n.text}`)
  );
  const existingIssues = new Set(
    (
      await db.all<{ part_id: string; dept: string; date: string }>(
        "select i.part_id, i.dept, i.date from pa_review_issues i join pa_parts p on p.id = i.part_id where p.project_id = ?",
        [pid]
      )
    ).map((i) => `${i.part_id}|${i.dept}|${i.date}`)
  );

  // 在這份檔案裡當過別人「上一階」的料號＝母階組件，它本身不用做 PA
  const assemblies = new Set(parsed.rows.map((r) => r.values.parent_pn ?? "").filter(Boolean));
  const diff: Diff = { added: [], changed: [], filled: 0, issuesAdded: 0, notesAdded: 0, removed: [], restored: [], autoExcluded: [], autoStarted: 0 };
  // PM 把 BOM 匯進來就等於發起 PA:「發起 PA」空白的料自動填匯入當天。
  // 已經有日期的一律不動 —— 重新匯入時只有新加進來的料會從這次的匯入日起算(2026-10-08 使用者規則)。
  const today = todayIn(TIMEZONE);
  const started: string[] = [];
  const ops: ((t: Db) => Promise<void>)[] = [];
  const ts = now();
  const hist = (t: Db, partId: string, field: string, from: string | null, to: string | null) =>
    t.run("insert into pa_part_history (part_id, user_id, field, old_value, new_value, at) values (?,?,?,?,?,?)", [
      partId, userId, field, from, to, ts,
    ]);
  const seenIds = new Set<string>();

  parsed.rows.forEach((row, idx) => {
    const v = row.values;
    const key = `${v.main_pn ?? ""} ${v.part_pn}${row.dupFg ? `\u0000${v.fg_pn ?? ""}` : ""}`;
    const cur = byKey.get(key);
    if (!cur) {
      diff.added.push({ part_pn: v.part_pn!, part_desc: v.part_desc ?? "" });
      const id = newId();
      const isAssembly = assemblies.has(v.part_pn ?? "");
      if (isAssembly) diff.autoExcluded.push({ part_pn: v.part_pn!, part_desc: v.part_desc ?? "" });
      else if (!v.pa_start) {
        v.pa_start = today;
        diff.autoStarted++;
        started.push(id);
      }
      const cols = ["id", "project_id", "sort_order", "created_at", "updated_at", "part_pn", "excluded", "excluded_note", ...BOM_KEYS, ...FILL_KEYS];
      const vals = [id, pid, idx, ts, ts, v.part_pn, isAssembly ? 1 : 0, isAssembly ? "母階組件" : "", ...BOM_KEYS.map((k) => v[k] ?? ""), ...FILL_KEYS.map((k) => {
        const f = FIELDS.find((x) => x.key === k)!;
        return f.kind === "date" ? v[k] ?? null : v[k] ?? "";
      })];
      diff.issuesAdded += row.issues.length;
      diff.notesAdded += row.notes.length;
      ops.push(async (t) => {
        await t.run(`insert into pa_parts (${cols.join(",")}) values (${cols.map(() => "?").join(",")})`, vals);
        await hist(t, id, "import:new", null, v.part_pn!);
        for (const i of row.issues) {
          await t.run("insert into pa_review_issues (id, part_id, dept, date, note, created_by, created_at) values (?,?,?,?,?,?,?)", [
            newId(), id, i.dept, i.date, "（BOM 匯入）", userId, ts,
          ]);
        }
        for (const n of row.notes) {
          await t.run("insert into pa_part_notes (id, part_id, date, text, created_by, created_at) values (?,?,?,?,?,?)", [
            newId(), id, n.date, n.text, userId, ts,
          ]);
        }
      });
      return;
    }
    seenIds.add(cur.id);
    const sets: [string, string | null][] = [];
    const changes: Diff["changed"][number]["changes"] = [];
    for (const k of BOM_KEYS) {
      if (v[k] === undefined) continue; // 檔案沒有這一欄
      const to = v[k] ?? "";
      if (to !== cur[k]) {
        sets.push([k, to]);
        changes.push({ field: FIELDS.find((f) => f.key === k)!.label, from: cur[k], to });
      }
    }
    if (changes.length) diff.changed.push({ part_pn: cur.part_pn, changes });
    for (const k of FILL_KEYS) {
      const to = v[k];
      const now_ = cur[k as keyof Part];
      if (to && !now_) {
        sets.push([k, to]);
        diff.filled++;
      }
    }
    if (!cur.pa_start && !v.pa_start && !cur.excluded) {
      sets.push(["pa_start", today]);
      diff.autoStarted++;
      started.push(cur.id);
    }
    const restore = cur.removed_from_bom === 1;
    if (restore) diff.restored.push({ part_pn: cur.part_pn });
    const newIssues = row.issues.filter((i) => !existingIssues.has(`${cur.id}|${i.dept}|${i.date}`));
    diff.issuesAdded += newIssues.length;
    const newNotes = row.notes.filter((n) => !existingNotes.has(`${cur.id}|${n.date}|${n.text}`));
    diff.notesAdded += newNotes.length;
    ops.push(async (t) => {
      const all = [...sets, ["removed_from_bom", "0"] as [string, string], ["sort_order", String(idx)] as [string, string]];
      await t.run(
        `update pa_parts set ${all.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? where id = ?`,
        [...all.map(([, x]) => (x === null ? null : x)), ts, cur.id]
      );
      for (const [k, x] of sets) await hist(t, cur.id, k, (cur[k as keyof Part] as string | null) ?? null, x);
      if (restore) await hist(t, cur.id, "import:restored", null, null);
      for (const i of newIssues) {
        await t.run("insert into pa_review_issues (id, part_id, dept, date, note, created_by, created_at) values (?,?,?,?,?,?,?)", [
          newId(), cur.id, i.dept, i.date, "（BOM 匯入）", userId, ts,
        ]);
      }
      for (const n of newNotes) {
        await t.run("insert into pa_part_notes (id, part_id, date, text, created_by, created_at) values (?,?,?,?,?,?)", [
          newId(), cur.id, n.date, n.text, userId, ts,
        ]);
      }
    });
  });

  // 「已不在 BOM」只在這個檔案涵蓋的主料範圍內判斷：匯入某一個組件的 BOM，
  // 不代表別的組件底下的料就消失了（PDF 一次只有一個組件）。
  const scope = new Set(parsed.rows.map((r) => r.values.main_pn ?? ""));
  for (const p of existing) {
    if (seenIds.has(p.id) || p.removed_from_bom || !scope.has(p.main_pn)) continue;
    diff.removed.push({ part_pn: p.part_pn, part_desc: p.part_desc });
    ops.push(async (t) => {
      await t.run("update pa_parts set removed_from_bom = 1, updated_at = ? where id = ?", [ts, p.id]);
      await hist(t, p.id, "import:removed", null, null);
    });
  }

  return {
    diff,
    started,
    apply: () =>
      db.tx(async (t) => {
        for (const op of ops) await op(t);
        await t.run("update pa_projects set updated_at = ? where id = ?", [ts, pid]);
      }),
  };
}

const isPdf = (buf: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(5, buf.byteLength))) === "%PDF-";

/** Excel（PA tracker / BOM 表）或 PLM 匯出的 BOM PDF，兩種都吃。 */
export async function parseImportFile(buf: ArrayBuffer): Promise<ParseResult> {
  if (!isPdf(buf)) return parseWorkbook(buf);
  let header, rows, warnings;
  try {
    ({ header, rows, warnings } = await parseBomPdf(buf));
  } catch (e) {
    if (e instanceof BomPdfError) throw new HttpError(400, e.message);
    throw e;
  }
  return {
    source: "pdf",
    sheet: `${header.top_pn} ${header.top_desc}`.trim(),
    header,
    mapped: [
      { column: "Item Number", field: "材料料號" },
      { column: "Item Description", field: "材料品名" },
      { column: "BOM 表頭組件", field: "主料料號" },
      { column: "Mfr Name", field: "供應商（只補空白）" },
      { column: "Level / Find Num / Quantity / Ref Des", field: "BOM 階層、用量、位置" },
    ],
    ignored: ["Mfr Part Number", "Mfr Part Description", "Mfr Part Lifecycle Phase", "Preferred Status"],
    rows,
    warnings,
  };
}

export async function importBom(
  a: Access,
  userId: string,
  buf: ArrayBuffer,
  commit: boolean,
  overrides: { fg_model?: string } = {},
  events: PaEvent[] = []
) {
  requireManage(a);
  const parsed = await parseImportFile(buf);
  if (!parsed.rows.length) throw new HttpError(400, "檔案裡沒有任何料號");
  // PDF 的組件品名（例如「Main PCBA ASSY w/o WIFI,XPLORER TOUCH」）不一定等於這個專案慣用的
  // 成品機種名稱。沒有指定的話沿用系統裡同一個主料已經在用的名稱，免得每次匯入都整批改名。
  if (parsed.source === "pdf") {
    const existing = (
      await db.get<{ fg_model: string }>(
        "select fg_model from pa_parts where project_id = ? and main_pn = ? and fg_model <> '' limit 1",
        [a.project.id, parsed.header?.top_pn ?? ""]
      )
    )?.fg_model;
    const model = overrides.fg_model?.trim() || existing || parsed.header?.top_desc || "";
    for (const r of parsed.rows) r.values.fg_model = model;
    parsed.fgModel = model;
  } else if (overrides.fg_model?.trim()) {
    for (const r of parsed.rows) r.values.fg_model = overrides.fg_model.trim();
  }
  await resolveOwners(a, parsed);
  const p = await plan(a, userId, parsed);
  if (commit) {
    await p.apply();
    // 自動發起的料一樣通知 Sourcer(每個人一封,列出全部)
    events.push(...p.started.map((partId) => ({ kind: "start" as const, partId })));
  }
  const { rows, ...meta } = parsed;
  return { ...meta, rowCount: rows.length, diff: p.diff, committed: commit };
}

/** Excel 的「Sourcer owner」「RD owner」欄寫的是人名（Joy），資料庫存的是帳號 id。
 *  對得到這個專案的成員才填，對不到就留白並在警告裡說一聲——不能把不是成員的人
 *  設成負責人，否則逾期信會寄給看不到這個專案的人。RD owner 還要是這個專案的 RD。 */
async function resolveOwners(a: Access, parsed: ParseResult) {
  const keys = (["sourcer_owner", "rd_owner"] as const).filter((k) => parsed.rows.some((r) => r.values[k]));
  if (!keys.length) return;
  const members = await listMembers(a.project.id);
  for (const key of keys) {
    const label = FIELDS.find((f) => f.key === key)!.label;
    const byName = new Map<string, string>();
    for (const m of members) {
      if (key === "rd_owner" && !m.roles.includes(OWNER_ROLE.rd_owner)) continue;
      for (const k of [m.name, m.email, m.email.split("@")[0]]) {
        if (k) byName.set(k.trim().toLowerCase(), m.user_id);
      }
    }
    const unknown = new Set<string>();
    for (const r of parsed.rows) {
      const raw = (r.values[key] ?? "").trim();
      if (!raw) continue;
      const id = byName.get(raw.toLowerCase());
      if (id) r.values[key] = id;
      else {
        unknown.add(raw);
        r.values[key] = "";
      }
    }
    for (const name of unknown) {
      parsed.warnings.push(
        `${label}「${name}」不是這個專案的${key === "rd_owner" ? " RD" : "成員"}（略過，可在專案設定把他加進來再匯一次）`
      );
    }
  }
}

// ---------- 匯出 ----------

const RED = "FFFF8A80";
const YELLOW = "FFFFF176";

export async function exportXlsx(a: Access): Promise<Buffer> {
  const sla = await getSla(a.project.id);
  const parts = await listParts(a.project.id);
  const issues = await db.all<Issue>(
    "select i.* from pa_review_issues i join pa_parts p on p.id = i.part_id where p.project_id = ? order by i.date",
    [a.project.id]
  );
  const notes = await db.all<{ part_id: string; date: string; text: string }>(
    "select n.part_id, n.date, n.text from pa_part_notes n join pa_parts p on p.id = n.part_id where p.project_id = ? order by n.date, n.created_at",
    [a.project.id]
  );
  const memberName = new Map((await listMembers(a.project.id)).map((m) => [m.user_id, m.name]));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("PA tracker", { views: [{ state: "frozen", xSplit: 5, ySplit: 1 }] });
  const cols: { header: string; key: string; width: number; date?: boolean }[] = [
    { header: "成品料號", key: "fg_pn", width: 15 },
    { header: "成品機種", key: "fg_model", width: 18 },
    { header: "成品機種材料品名", key: "fg_desc", width: 18 },
    { header: "主料料號", key: "main_pn", width: 15 },
    { header: "材料料號", key: "part_pn", width: 16 },
    { header: "LIFECYCLE", key: "lifecycle", width: 22 },
    { header: "階段", key: "phase", width: 14 },
    { header: "材料品名", key: "part_desc", width: 40 },
    { header: "屬性\n標準件 (IC, RLC, Connector,…)\n訂製件 (PCB, Cover, Frame, Cable…)", key: "part_type", width: 14 },
    { header: "供應商", key: "supplier", width: 16 },
    { header: "Sourcer owner", key: "sourcer_owner", width: 12 },
    { header: "remark（進度紀錄）", key: "notes", width: 42 },
    { header: "PM/RD 發起 PA \n日期", key: "pa_start", width: 13, date: true },
    { header: "Sourcer 通知供應商 \n日期", key: "supplier_notified", width: 13, date: true },
    { header: "Sourcer 通知QA \n收到供應商完整資料\n日期", key: "docs_received", width: 15, date: true },
    { header: "RD review 完成 & pass\n日期", key: "rd_pass", width: 13, date: true },
    { header: "QA review 完成 & pass\n日期", key: "qa_pass", width: 13, date: true },
    { header: "上傳 PLM 送簽\n日期", key: "plm_upload", width: 13, date: true },
    { header: "PLM Released\n日期", key: "plm_released", width: 13, date: true },
    { header: "卡關原因", key: "hold_reason", width: 14 },
    { header: "RD owner", key: "rd_owner", width: 12 },
    { header: "承認樣品\n日期", key: "sample_received", width: 13, date: true },
    { header: "供應商更新資料\n日期", key: "supplier_updated", width: 14, date: true },
    { header: "圖面 Release\n日期", key: "drawing_release", width: 13, date: true },
    { header: "RD\nReview iteration record\nDate to give issues to supplier", key: "rd_issues", width: 16 },
    { header: "QA \nReview iteration record\nDate to give issues to supplier", key: "qa_issues", width: 16 },
    { header: "RD 開始 review", key: "rd_review_start", width: 13, date: true },
    { header: "QA 開始 review", key: "qa_review_start", width: 13, date: true },
    { header: "已不在 BOM", key: "removed", width: 10 },
    { header: "不追蹤", key: "excluded", width: 12 },
    { header: "BOM 階層", key: "bom_level", width: 9 },
    { header: "上一階料號", key: "parent_pn", width: 15 },
    { header: "Find Num", key: "find_num", width: 9 },
    { header: "替代料（替代誰）", key: "alt_of_pn", width: 15 },
    { header: "用量", key: "qty", width: 7 },
    { header: "Ref Des（位置）", key: "ref_des", width: 30 },
  ];
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.height = 60;
  head.eachCell((c) => {
    c.font = { bold: true };
    c.alignment = { wrapText: true, vertical: "middle" };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAED" } };
  });

  const issuesOf = (partId: string, dept: string) =>
    issues
      .filter((i) => i.part_id === partId && i.dept === dept)
      .map((i) => i.date + (i.note && i.note !== "（BOM 匯入）" ? ` ${i.note}` : "") + (i.resubmitted ? `（供應商 ${i.resubmitted} 更新）` : ""));
  const asDate = (s: string | null) => (s ? new Date(`${s}T00:00:00Z`) : null);

  for (const p of parts) {
    const row = ws.addRow({
      ...Object.fromEntries(cols.filter((c) => c.date).map((c) => [c.key, asDate(p[c.key as keyof Part] as string | null)])),
      fg_pn: p.fg_pn, fg_model: p.fg_model, fg_desc: p.fg_desc, main_pn: p.main_pn, part_pn: p.part_pn,
      lifecycle: p.lifecycle, phase: PHASE_BY_KEY[p.ev.phase].label, hold_reason: p.hold_reason, part_desc: p.part_desc, part_type: p.part_type, supplier: p.supplier,
      rd_issues: issuesOf(p.id, "RD").join("\n"), qa_issues: issuesOf(p.id, "QA").join("\n"),
      sourcer_owner: memberName.get(p.sourcer_owner) ?? "",
      rd_owner: memberName.get(p.rd_owner) ?? "",
      notes: notes.filter((n) => n.part_id === p.id).map((n) => `${n.date} ${n.text}`).join("\n"),
      removed: p.removed_from_bom ? "Y" : "",
      excluded: p.excluded ? p.excluded_note || "Y" : "",
    });
    for (const c of cols.filter((c) => c.date)) row.getCell(c.key).numFmt = "yyyy/mm/dd";
    row.getCell("notes").alignment = { wrapText: true };
    row.getCell("rd_issues").alignment = { wrapText: true };
    row.getCell("qa_issues").alignment = { wrapText: true };
    for (const s of STAGES) {
      const light = p.ev[s.key].light;
      // 跟畫面一樣:還沒開始 review 的紅燈塗在「開始 review」那格
      if (light) row.getCell(slaColumn(p, s.key)).fill = { type: "pattern", pattern: "solid", fgColor: { argb: light === "red" ? RED : YELLOW } };
    }
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

  // 階段統計:跟專案頁上方 Dashboard 同一張表(已不在 BOM 的不算)
  const sum = wb.addWorksheet("階段統計");
  sum.columns = [{ header: "階段", width: 16 }, { header: "料件數", width: 9 }, { header: "佔比", width: 9 }, { header: "負責單位", width: 12 }, { header: "說明", width: 46 }];
  sum.getRow(1).font = { bold: true };
  const inBom = parts.filter((p) => !p.removed_from_bom);
  for (const ph of PHASES) {
    const n = inBom.filter((p) => p.ev.phase === ph.key).length;
    const r = sum.addRow([ph.label, n, inBom.length ? n / inBom.length : 0, ph.owner, ph.desc]);
    r.getCell(3).numFmt = "0.0%";
  }
  sum.addRow(["合計", inBom.length, 1, "", ""]).font = { bold: true };

  const cfg = wb.addWorksheet("SLA 與狀態");
  cfg.columns = [{ width: 44 }, { width: 10 }];
  cfg.addRow(["SLA（日曆天，自前一步完成日起算）", "天數"]).font = { bold: true };
  for (const f of SLA_FIELDS) cfg.addRow([`${f.label}（${f.from}）`, sla[f.key]]);
  cfg.addRow([]);
  cfg.addRow(["紅：尚未完成且已超過 SLA；黃：已完成但花的天數超過 SLA"]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
