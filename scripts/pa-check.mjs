// PA Tracker 的整套檢查:權限、匯入(Excel 與 PLM 的 BOM PDF)、
// 紅黃燈、批次、不追蹤、匯出、每日信。
//
// 全部在暫時資料夾裡的 SQLite 檔跑,跑完整個刪掉,**不會碰到正式的 patracker.db**。
//
// 跑法:
//   npm run check:pa
//
// 需要的檔案:data/fixtures/pa-tracker-sample.xlsx 與 data/fixtures/D813-000002-.pdf

import { register } from "node:module";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

register("./pa-alias-loader.mjs", import.meta.url);

const TMP = mkdtempSync(join(tmpdir(), "pa-check-"));
process.env.DB_PATH = join(TMP, "patracker.db");
// 這支腳本不寄信
process.env.SMTP_HOST = "";

let failures = 0;
const ok = (label, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
};
const section = (s) => console.log(`\n${s}`);

async function rejects(label, fn, status) {
  try {
    await fn();
    ok(label, false, "沒有被擋下來");
  } catch (e) {
    ok(label, e?.status === status, `status=${e?.status ?? "?"} ${e?.message ?? e}`);
  }
}

async function main() {
  const { db } = await import("../src/server/pa/db.ts");
  // ---------- 一個真的帳號:成員名單、每日信要查得到人 ----------
  const real = { id: randomUUID(), email: "real@example.com", name: "Real User", role: "admin" };
  await db.run(
    "insert into users (id, email, password_hash, name, role, created_at, updated_at) values (?,?,?,?,?,?,?)",
    [real.id, real.email, "none$x", real.name, real.role, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const P = await import("../src/server/pa/projects.ts");
  const Parts = await import("../src/server/pa/parts.ts");
  const Bom = await import("../src/server/pa/bom.ts");
  const Digest = await import("../src/server/pa/digest.ts");
  const { evalPart, derivePhase, slaColumn, DEFAULT_SLA, ESCALATE_AT } = await import("../src/lib/pa.ts");
  const Notify = await import("../src/server/pa/notify.ts");

  const user = (id, role, name) => ({ id, email: `${name}@example.com`, name, account_role: role, isAdmin: role === "admin" });
  const pm = user(randomUUID(), "pm", "pm");
  const sourcer = user(randomUUID(), "user", "sourcer");
  const rd = user(randomUUID(), "user", "rd");
  const sysadmin = user(real.id, "admin", real.name || "admin");
  const outsider = user(randomUUID(), "user", "outsider");

  // ---------- 建專案 ----------
  section("建專案與權限");
  const project = await P.createProject(pm, "檢查用專案", "CHK");
  ok("建立專案", Boolean(project.id));
  const sla = await P.getSla(project.id);
  ok("SLA 預設值 = 原 Excel 的 3/7/21/7/7", JSON.stringify(sla) === JSON.stringify(DEFAULT_SLA), JSON.stringify(sla));
  const aPm = await P.access(project.id, pm);
  ok("建立者自動是這個專案的 PM", aPm.roles.includes("pm") && aPm.canManage);
  await rejects("不是成員的人看不到專案(404)", () => P.access(project.id, outsider), 404);
  const aAdmin = await P.access(project.id, sysadmin);
  ok("系統 admin 看得到也管得了", aAdmin.canManage && aAdmin.isAdmin);
  await rejects("一般使用者不能建立專案(403)", () => P.createProject(sourcer, "不該成立", ""), 403);

  // 成員:sourcer / rd,另外把真實帳號掛成 sourcer(每日信要用)
  const ts = new Date().toISOString();
  for (const [u, role] of [[sourcer, "sourcer"], [rd, "rd"]]) {
    await db.run("insert into pa_project_members (project_id, user_id, role, created_at) values (?,?,?,?)", [project.id, u.id, role, ts]);
  }
  await P.setMemberRoles(aPm, real.id, ["sourcer"]);
  const members = await P.listMembers(project.id);
  ok("成員名單含 PM/sourcer/rd + 真實帳號", members.length === 4, `${members.length} 位`);
  ok("真實帳號的名字查得到(profiles)", members.some((m) => m.user_id === real.id && m.email === real.email));
  await rejects("加成員時擋掉不存在的帳號", () => P.setMemberRoles(aPm, "00000000-0000-0000-0000-000000000000", ["rd"]), 400);

  // 一般成員可以自己拉人進來、調角色,但 PM 那一格不行
  const aRdMember = await P.access(project.id, rd);
  await P.setMemberRoles(aRdMember, real.id, ["sourcer", "qa"]);
  ok("成員可以調整別人的 Sourcer/RD/QA", (await P.rolesOf(project.id, real.id)).sort().join() === "qa,sourcer");
  await rejects("成員不能把人指派成 PM(403)", () => P.setMemberRoles(aRdMember, real.id, ["sourcer", "pm"]), 403);
  await rejects("成員不能把別人的 PM 拿掉(403)", () => P.setMemberRoles(aRdMember, pm.id, ["rd"]), 403);
  ok("被擋下來之後 PM 還在", (await P.rolesOf(project.id, pm.id)).includes("pm"));
  await P.setMemberRoles(aPm, real.id, ["sourcer"]);
  // 「至少留一位 PM」要用真的帳號才測得到:假 id 會先被上面那條擋掉
  const solo = await P.createProject(sysadmin, "只有一位 PM 的專案", "");
  const aSolo = await P.access(solo.id, sysadmin);
  try {
    await P.setMemberRoles(aSolo, sysadmin.id, []);
    ok("不能把最後一位 PM 移掉", false, "沒有被擋下來");
  } catch (e) {
    ok("不能把最後一位 PM 移掉", e?.status === 400 && /至少要保留一位 PM/.test(e.message), e?.message ?? String(e));
  }
  ok("被擋下來之後角色沒有被改掉(交易有回滾)", (await P.rolesOf(solo.id, sysadmin.id)).includes("pm"));
  await db.run("delete from pa_projects where id = ?", [solo.id]);

  // ---------- 匯入 Excel ----------
  section("匯入 PA tracker 的 Excel");
  const xlsxPath = new URL("../data/fixtures/pa-tracker-sample.xlsx", import.meta.url);
  const pdfPath = new URL("../data/fixtures/D813-000002-.pdf", import.meta.url);
  if (!existsSync(xlsxPath)) {
    console.log("  跳過:找不到 data/fixtures/pa-tracker-sample.xlsx");
  } else {
    const buf = readFileSync(xlsxPath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const preview = await Bom.importBom(aPm, pm.id, ab, false);
    ok("預覽:有抓到料號", preview.rowCount > 0, `${preview.rowCount} 列`);
    ok("預覽不寫入", (await Parts.listParts(project.id)).length === 0);
    const done = await Bom.importBom(aPm, pm.id, ab, true);
    const after = await Parts.listParts(project.id);
    ok("確認後寫入", after.length === done.rowCount, `${after.length} 顆料`);
    const todayStr = (await import("../src/lib/pa.ts")).todayIn("Asia/Taipei");
    ok("匯入就自動發起:發起 PA 空白的填今天", after.every((p) => p.excluded || p.pa_start), `自動發起 ${done.diff.autoStarted} 顆`);
    ok("檔案裡有寫發起日的照用", after.some((p) => p.pa_start && p.pa_start !== todayStr));
    const startedAt = new Map(after.map((p) => [p.id, p.pa_start]));
    const again = await Bom.importBom(aPm, pm.id, ab, true);
    ok("再匯一次:發起日都不動", (await Parts.listParts(project.id)).every((p) => p.pa_start === startedAt.get(p.id)) && again.diff.autoStarted === 0);
    ok("同一份再匯一次:沒有新增", again.diff.added.length === 0);
    ok("同一份再匯一次:沒有變更", again.diff.changed.length === 0 && again.diff.filled === 0);
    ok("同一份再匯一次:沒有人被標成已不在 BOM", again.diff.removed.length === 0);
    await rejects("只有 PM/admin 能匯入(403)", async () => {
      const aSourcer = await P.access(project.id, sourcer);
      return Bom.importBom(aSourcer, sourcer.id, ab, false);
    }, 403);
  }

  // ---------- 匯入 BOM PDF ----------
  section("匯入 PLM 的 BOM PDF");
  let pdfPart = null;
  if (!existsSync(pdfPath)) {
    console.log("  跳過:找不到 data/fixtures/D813-000002-.pdf");
  } else {
    const before = (await Parts.listParts(project.id)).length;
    const buf = readFileSync(pdfPath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const startEvents = [];
    const r = await Bom.importBom(aPm, pm.id, ab, true, { fg_model: "XPLORER" }, startEvents);
    ok("解析出 138 列", r.rowCount === 138, `${r.rowCount} 列`);
    ok("主料料號 = BOM 最上層組件", r.header?.top_pn === "002-D813-000", r.header?.top_pn ?? "?");
    ok("母階組件自動標成不追蹤", r.diff.autoExcluded.length > 0, `${r.diff.autoExcluded.length} 顆`);
    ok("新加進來的料自動發起(母階組件不算)", r.diff.autoStarted === r.diff.added.length - r.diff.autoExcluded.length, `${r.diff.autoStarted} 顆`);
    ok("自動發起的料會通知 Sourcer", startEvents.length === r.diff.autoStarted && startEvents.every((e) => e.kind === "start"));
    ok("Excel 匯進來的料沒有被標成已不在 BOM", r.diff.removed.length === 0);
    const all = await Parts.listParts(project.id);
    ok("料號總數 = 原本 + 這次新增的", all.length === before + r.diff.added.length, `${all.length}（新增 ${r.diff.added.length}）`);
    const pdfParts = all.filter((p) => p.main_pn === "002-D813-000");
    ok("PDF 的料都掛在同一個主料底下", pdfParts.length === 138);
    ok("BOM 階層有存下來", pdfParts.some((p) => p.bom_level && p.parent_pn));
    ok("替代料有標出替代誰", pdfParts.some((p) => p.alt_of_pn));
    ok("Mfr Name 帶進供應商", pdfParts.some((p) => p.supplier));
    ok("成品機種吃指定的名稱", pdfParts.every((p) => p.fg_model === "XPLORER"));
    pdfPart = pdfParts.find((p) => !p.excluded) ?? null;
  }

  // ---------- 匯入 Agile 的 BOM .xls ----------
  section("匯入 Agile PLM 的 BOM .xls");
  {
    const XLSX = await import("xlsx");
    const Agile = await import("../src/server/pa/bomAgile.ts");
    const H = ["Level", "Part Number", "Part Name / Description", "Lifecycle Phase", "Rev", "BOM.Find Num", "BOM.Quantity", "BOM.Ref Des", "Manufacturers.Mfr Name"];
    const data = [
      H,
      ["0", "000-X100-000", "TOP ASM", "ES1", "X0.00*1  BDC-000001", "", "", "", ""],
      ["1", "001-X100-000", "DRESS", "ES1", "X0.01*1", "1", "1", "", ""],
      ["2", "1-051-0001-001", "PART A", "Part Approved", "", "2", "1", "", "菁英電子"],
      ["2", "1-051-0002-001", "PART B", "Part Approved", "", "3", "2", "C1", ""],
      ["2", "1-051-0002-101", "PART B ALT", "Part Approved", "", "3-1", "2", "C1", ""],
      ["3", "1-051-0003-001", "PART C", "Part Approved", "", "1", "1", "", ""],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), "Sheet0");
    const out = XLSX.write(wb, { type: "buffer", bookType: "biff8" });
    const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    ok("認得 .xls 檔頭", Agile.isXls(ab));
    const r = Agile.parseAgileXls(ab);
    ok("最上層組件 = Level 0", r.header.top_pn === "000-X100-000" && r.header.top_desc === "TOP ASM");
    ok("解析出 5 列(不含 Level 0)", r.rows.length === 5, `${r.rows.length}`);
    ok("主料料號 = 最上層組件", r.rows.every((x) => x.values.main_pn === "000-X100-000"));
    ok("上一階依 Level 推出來", r.rows[2].values.parent_pn === "001-X100-000" && r.rows[4].values.parent_pn === "1-051-0002-101");
    ok("3-1 標成 3 的替代料", r.rows[3].values.alt_of_pn === "1-051-0002-001");
    ok("製造商帶進供應商、中文不亂碼", r.rows[1].values.supplier === "菁英電子");
    ok("用量與 Ref Des 有帶", r.rows[2].values.qty === "2" && r.rows[2].values.ref_des === "C1");
    // 同一顆料掛在兩個上階底下:匯入只取第一筆(不然會撞唯一鍵 23505)
    const dup = [...data, ["3", "1-051-0001-001", "PART A", "Part Approved", "", "2", "1", "", ""]];
    const wb2 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(dup), "Sheet0");
    const out2 = XLSX.write(wb2, { type: "buffer", bookType: "biff8" });
    const rd = await Bom.parseImportFile(out2.buffer.slice(out2.byteOffset, out2.byteOffset + out2.byteLength));
    ok("重複料號只留一筆並提醒", rd.rows.length === 5 && rd.warnings.some((w) => w.includes("1-051-0001-001")), `${rd.rows.length} 列`);
    let bad = null;
    try { Agile.parseAgileXls(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]).buffer); } catch (e) { bad = e; }
    ok("壞檔給清楚的錯誤", bad && /xls/.test(bad.message), bad?.message);
  }

  // ---------- 逐欄權限 ----------
  section("誰能改哪一欄");
  const target = pdfPart ?? (await Parts.listParts(project.id)).find((p) => !p.excluded);
  const aSourcer = await P.access(project.id, sourcer);
  const aRd = await P.access(project.id, rd);
  await rejects("Sourcer 不能填「PM/RD 發起 PA」(403)", () => Parts.updatePartField(aSourcer, sourcer.id, target.id, "pa_start", "2026-01-05"), 403);
  await Parts.updatePartField(aPm, pm.id, target.id, "pa_start", "2026-01-05");
  await Parts.updatePartField(aSourcer, sourcer.id, target.id, "supplier_notified", "2026-01-06");
  await rejects("RD 不能填 QA 的 pass(403)", () => Parts.updatePartField(aRd, rd.id, target.id, "qa_pass", "2026-02-01"), 403);
  // 側欄已經不顯示修改紀錄了,但它還是要寫進資料庫(誰在何時改了什麼)
  const hist = await db.all("select field, user_id from pa_part_history where part_id = ?", [target.id]);
  ok("修改紀錄有寫", hist.length >= 2, `${hist.length} 筆`);
  ok("修改紀錄記得是誰改的", hist.some((h) => h.field === "supplier_notified" && h.user_id === sourcer.id));
  await rejects("日期格式擋得住(400)", () => Parts.updatePartField(aPm, pm.id, target.id, "pa_start", "2026/1/5"), 400);
  await rejects("屬性只能是標準件/訂製件(400)", () => Parts.updatePartField(aPm, pm.id, target.id, "part_type", "隨便"), 400);

  // ---------- 退件紀錄 ----------
  section("退件紀錄");
  const issue = await Parts.addIssue(aRd, rd.id, target.id, "RD", "2026-02-10", "外觀不符");
  ok("RD 記得了自己的退件", Boolean(issue.id));
  await rejects("別的專案的料號記不了退件(404)", () => Parts.addIssue(aRd, rd.id, "no-such-part", "RD", "2026-02-10", ""), 404);
  await rejects("別的專案的料號記不了進度(404)", () => Parts.addNote(aRd, rd.id, "no-such-part", "2026-02-10", "x"), 404);
  ok("退件帶回完整的一筆", issue.dept === "RD" && issue.note === "外觀不符" && !("n_after" in issue));
  await rejects("RD 不能記 QA 的退件(403)", () => Parts.addIssue(aRd, rd.id, target.id, "QA", "2026-02-11", ""), 403);
  await rejects("別人不能刪這筆退件(403)", () => Parts.deleteIssue(aSourcer, sourcer.id, issue.id), 403);
  await Parts.deleteIssue(aRd, rd.id, issue.id);
  ok("自己刪得掉", (await Parts.partDetail(aRd, target.id)).issues.length === 0);

  // ---------- 進度紀錄與負責人 ----------
  section("進度紀錄（remark）與 Sourcer owner");
  const n1 = await Parts.addNote(aRd, rd.id, target.id, "2026-02-20", "廠商資料處理中");
  ok("成員可以記一筆進度", Boolean(n1.id));
  ok("表格那一列帶最近幾筆", (await Parts.partRow(aPm, target.id)).recent_notes[0]?.text === "廠商資料處理中");
  ok("側欄看得到是誰記的", (await Parts.partDetail(aPm, target.id)).notes[0]?.created_by_name.length > 0);
  await rejects("空白的進度不給記(400)", () => Parts.addNote(aRd, rd.id, target.id, "2026-02-20", "  "), 400);
  await rejects("別人不能刪這筆進度(403)", () => Parts.deleteNote(aSourcer, sourcer.id, n1.id), 403);
  await Parts.deleteNote(aRd, rd.id, n1.id);
  ok("自己刪得掉", (await Parts.partRow(aPm, target.id)).recent_notes.length === 0);
  for (const [d, t] of [["2026-02-01", "一"], ["2026-02-02", "二"], ["2026-02-03", "三"], ["2026-02-04", "四"]]) {
    await Parts.addNote(aRd, rd.id, target.id, d, t);
  }
  const allNotes = (await Parts.partRow(aPm, target.id)).recent_notes;
  ok("表格那一格帶全部歷程(不只 3 筆),新到舊", allNotes.map((n) => n.text).join() === "四,三,二,一", allNotes.map((n) => n.text).join());
  ok("整張表一次查也是全部", (await Parts.listParts(project.id)).find((x) => x.id === target.id).recent_notes.length === 4);
  await db.run("delete from pa_part_notes where part_id = ?", [target.id]);

  const lines = Bom.parseNoteLines(["1/19廠商提供", "4/13已審，廠商修正中", "2026-09-16 初審", "12/25 出貨"].join("\n"), "2026-09-21");
  ok("remark 一行一筆", lines.length === 4, `${lines.length} 筆`);
  ok("只有月/日的補上今年", lines[0].date === "2026-01-19", lines[0].date);
  ok("完整日期照用", lines[2].date === "2026-09-16", lines[2].date);
  ok("比今天晚太多的當成去年", lines[3].date === "2025-12-25", lines[3].date);
  ok("日期後面的字就是內容", lines[1].text === "已審，廠商修正中", lines[1].text);

  await rejects("不是成員的人不能當負責人(400)", () => Parts.updatePartField(aPm, pm.id, target.id, "sourcer_owner", outsider.id), 400);
  await Parts.updatePartField(aPm, pm.id, target.id, "sourcer_owner", sourcer.id);
  ok("指定得了負責人", (await Parts.partRow(aPm, target.id)).sourcer_owner === sourcer.id);
  const routed = (await Digest.buildDigests("2026-03-01")).find((d) => d.user_id === real.id);
  ok(
    "指定負責人之後,這顆料的 Sourcer 逾期不再寄給其他 Sourcer",
    !routed?.projects.some((pr) => pr.items.some((i) => i.part_id === target.id)),
  );
  await Parts.updatePartField(aPm, pm.id, target.id, "sourcer_owner", "");

  // ---------- 紅黃燈 ----------
  section("SLA 紅黃燈");
  const today = "2026-03-01";
  await Parts.updatePartField(aPm, pm.id, target.id, "part_type", "標準件");
  const parts = await Parts.listParts(project.id, today);
  const t = parts.find((p) => p.id === target.id);
  ok("起算日過了 SLA 還沒完成 → 紅", t.ev.docs_received.light === "red", JSON.stringify(t.ev.docs_received));
  const noType = evalPart({ ...t, part_type: "" }, [], DEFAULT_SLA, today);
  ok("屬性空白就不判斷這一階", noType.docs_received.light === null);
  const yellow = evalPart(
    { ...t, part_type: "標準件", supplier_notified: "2026-01-06", docs_received: "2026-02-01" },
    [],
    DEFAULT_SLA,
    today
  );
  ok("完成但超過 SLA → 黃", yellow.docs_received.light === "yellow", JSON.stringify(yellow.docs_received));
  const green = evalPart(
    { ...t, part_type: "標準件", supplier_notified: "2026-01-06", docs_received: "2026-01-10" },
    [],
    DEFAULT_SLA,
    today
  );
  ok("準時完成 → 不標色", green.docs_received.light === null);

  // ---------- 批次與不追蹤 ----------
  section("批次編輯與不追蹤");
  const ids = parts.filter((p) => !p.excluded && !p.removed_from_bom).slice(0, 5).map((p) => p.id);
  const changed = await Parts.updatePartsField(aPm, pm.id, ids, "part_type", "標準件");
  ok("批次填屬性", changed > 0, `${changed} 筆`);
  await rejects("Sourcer 不能批次填屬性(403)", () => Parts.updatePartsField(aSourcer, sourcer.id, ids, "part_type", "訂製件"), 403);
  const excluded = await Parts.setExcluded(aPm, pm.id, [ids[0]], true);
  ok("PM 可以把料號標成不追蹤", excluded === 1);
  await rejects("沒有專案角色(唯讀)不能改不追蹤(403)", () => Parts.setExcluded({ ...aSourcer, roles: [], isAdmin: false, canManage: false }, sourcer.id, [ids[1]], true), 403);
  ok("專案成員(Sourcer)也能排除", (await Parts.setExcluded(aSourcer, sourcer.id, [ids[1]], true)) === 1);
  await Parts.setExcluded(aSourcer, sourcer.id, [ids[1]], false);
  const skipped = await Parts.updatePartsField(aPm, pm.id, [ids[0]], "part_type", "訂製件");
  ok("不追蹤的料不會被批次改到", skipped === 0);
  const restored = await Parts.setExcluded(aPm, pm.id, [ids[0]], false);
  ok("可以恢復追蹤", restored === 1);

  // ---------- 階段、退件升級、即時通知 ----------
  section("階段（Dashboard）");
  const base = { ...t, excluded: 0, hold_reason: "", pa_start: null, supplier_notified: null, docs_received: null,
    rd_review_start: null, qa_review_start: null, rd_pass: null, qa_pass: null, plm_upload: null, plm_released: null };
  const ph = (over, iss = []) => derivePhase({ ...base, ...over }, iss);
  ok("沒有日期 → 未發起", ph({}) === "not_started");
  ok("發起了 → 待通知廠商", ph({ pa_start: "2026-01-05" }) === "to_notify");
  ok("卡關原因還留著、但已上傳 PLM → PLM簽核", ph({ pa_start: "2026-01-05", hold_reason: "待RD圖面進版", plm_upload: "2026-10-30" }) === "plm_signing");
  ok("卡關中沒上傳 PLM → 還是卡關", ph({ pa_start: "2026-01-05", hold_reason: "待RD圖面進版" }) === "hold_ec");
  ok("待RD圖面進版、圖面已 Release → 待上傳 PLM", ph({ pa_start: "2026-01-05", hold_reason: "待RD圖面進版", drawing_release: "2026-10-30" }) === "plm_ready");
  {
    const hp = (await Parts.listParts(project.id)).find((p) => !p.excluded && !p.removed_from_bom && !p.plm_upload && !p.hold_reason);
    await Parts.updatePartField(aPm, pm.id, hp.id, "hold_reason", "待RD圖面進版");
    await Parts.updatePartField(aSourcer, sourcer.id, hp.id, "plm_upload", "2026-10-30");
    const after1 = (await Parts.listParts(project.id)).find((p) => p.id === hp.id);
    ok("上傳 PLM 後卡關原因自動清掉", after1.hold_reason === "" && after1.plm_upload === "2026-10-30", `[${after1.hold_reason}]`);
    await Parts.updatePartField(aSourcer, sourcer.id, hp.id, "plm_upload", null);
  }
  ok("通知了還沒收齊 → 廠商準備資料", ph({ pa_start: "2026-01-05", supplier_notified: "2026-01-06" }) === "supplier");
  const docs = { pa_start: "2026-01-05", supplier_notified: "2026-01-06", docs_received: "2026-01-10" };
  ok("收齊、QA 還沒 pass → 待QA審核", ph(docs) === "review_qa");
  ok("QA pass 了、有 RD owner → 才換待RD審核", ph({ ...docs, qa_pass: "2026-01-12", rd_owner: "someone" }) === "review_rd");
  ok("QA pass 了、沒有 RD owner → 直接可上PLM(不用 RD 審)", ph({ ...docs, qa_pass: "2026-01-12" }) === "plm_ready");
  ok("預約給還沒上線的 RD 也算有 RD owner", ph({ ...docs, qa_pass: "2026-01-12", rd_owner_pending: true }) === "review_rd");
  ok("RD 已經開始審 → 就算沒指定 owner 也要等 RD", ph({ ...docs, qa_pass: "2026-01-12", rd_review_start: "2026-01-13" }) === "review_rd");
  ok("QA 退件中 → 被QA退件(RD 不會先審)", ph(docs, [{ dept: "QA", date: "2026-01-11" }]) === "rework_qa");
  ok("RD 退件、QA pass → 被RD退件", ph({ ...docs, qa_pass: "2026-01-12" }, [{ dept: "RD", date: "2026-01-11" }]) === "rework_rd");
  ok("退件後 RD 重新開始 review → 回到待RD審核",
    ph({ ...docs, qa_pass: "2026-01-12", rd_review_start: "2026-01-20" }, [{ dept: "RD", date: "2026-01-11" }]) === "review_rd");
  const passed = { ...docs, rd_pass: "2026-01-12", qa_pass: "2026-01-13" };
  ok("RD、QA 都 pass → 可上PLM", ph(passed) === "plm_ready");
  ok("上傳 PLM → PLM簽核", ph({ ...passed, plm_upload: "2026-01-14" }) === "plm_signing");
  ok("Released → 已完成", ph({ ...passed, plm_upload: "2026-01-14", plm_released: "2026-01-20" }) === "done");
  ok("卡關 ISSUE 蓋過日期", ph({ ...docs, hold_reason: "ISSUE" }) === "hold_issue");
  ok("待RD圖面進版 蓋過可上PLM", ph({ ...passed, hold_reason: "待RD圖面進版" }) === "hold_ec");
  ok("Released 之後卡關原因不算", ph({ ...passed, plm_released: "2026-01-20", hold_reason: "ISSUE" }) === "done");
  ok("不追蹤 → 不需PA", ph({ ...passed, excluded: 1 }) === "na");
  const waitPlm = evalPart({ ...base, ...passed }, [], DEFAULT_SLA, today);
  ok("可上PLM 時輪到 Sourcer", waitPlm.waitingOn.includes("sourcer"));

  section("燈號顯示在哪一格");
  ok("還沒開始 review → 掛在開始 review", slaColumn({ ...base, ...docs }, "qa_pass") === "qa_review_start");
  ok("開始 review 了 → 回到 pass", slaColumn({ ...base, ...docs, qa_review_start: "2026-01-11" }, "qa_pass") === "qa_pass");
  ok("沒開始就直接 pass → 黃燈留在 pass", slaColumn({ ...base, ...docs, qa_pass: "2026-02-01" }, "qa_pass") === "qa_pass");
  ok("開始 review 那欄收起來 → 照舊顯示在 pass", slaColumn({ ...base, ...docs }, "rd_pass", false) === "rd_pass");
  ok("其他階段不受影響", slaColumn({ ...base, ...docs }, "docs_received") === "docs_received");

  section("退件 ≥4 次升級");
  const four = Array.from({ length: ESCALATE_AT }, (_, i) => ({ dept: "RD", date: `2026-01-1${i}` }));
  ok(`RD 退件 ${ESCALATE_AT} 次、還沒 pass → 需協助`, evalPart({ ...base, ...docs }, four, DEFAULT_SLA, today).escalated.join() === "RD");
  ok("RD pass 之後就不用再協助", evalPart({ ...base, ...docs, rd_pass: "2026-02-01" }, four, DEFAULT_SLA, today).escalated.length === 0);
  ok(`${ESCALATE_AT - 1} 次還不用`, evalPart({ ...base, ...docs }, four.slice(1), DEFAULT_SLA, today).escalated.length === 0);
  ok("需協助時輪到 PM", evalPart({ ...base, ...docs }, four, DEFAULT_SLA, today).waitingOn.includes("pm"));

  section("卡關原因與 PLM 欄位");
  // 挑一顆什麼日期都還沒填的料,從頭走一遍流程
  // 匯入時都自動發起了;挑幾顆還沒收齊資料的,把發起日清掉,從頭走一遍流程
  const blank = (await Parts.listParts(project.id)).filter((p) => !p.excluded && !p.removed_from_bom && !p.docs_received && !p.supplier_notified && p.id !== target.id);
  await db.run("update pa_parts set pa_start = null where id = any(?::text[])", [blank.map((p) => p.id)]);
  const flow = blank[0].id;
  await rejects("卡關原因太長(400)", () => Parts.updatePartField(aPm, pm.id, flow, "hold_reason", "長".repeat(41)), 400);
  await Parts.updatePartField(aSourcer, sourcer.id, flow, "hold_reason", "ISSUE");
  ok("Sourcer 也可以標卡關(全部成員都能用)", (await Parts.partRow(aPm, flow)).ev.phase === "hold_issue");
  await Parts.updatePartField(aSourcer, sourcer.id, flow, "hold_reason", "");
  await rejects("RD 不能填上傳 PLM(403)", () => Parts.updatePartField(aRd, rd.id, flow, "plm_upload", "2026-02-20"), 403);
  await Parts.updatePartField(aRd, rd.id, flow, "hold_reason", "ISSUE");
  ok("RD 可以標 ISSUE", (await Parts.partRow(aPm, flow)).ev.phase === "hold_issue");
  await Parts.updatePartField(aPm, pm.id, flow, "hold_reason", "");

  section("卡關:自由填原因、日期、負責人、完成日期");
  {
    const n0 = (await Parts.partDetail(aPm, flow)).holds.length;
    await Parts.setHold(aPm, pm.id, flow, { reason: "廠商停產", since: "2026-03-01", owner: sourcer.id, note: "等替代料" });
    const r1 = (await Parts.listParts(project.id)).find((x) => x.id === flow);
    ok("自由填的原因 → 卡關(ISSUE 那一段)", r1.hold_reason === "廠商停產" && r1.ev.phase === "hold_issue", r1.ev.phase);
    ok("卡關日期、負責人、備註存起來", r1.hold_since === "2026-03-01" && r1.hold_owner === sourcer.id && r1.hold_note === "等替代料");
    await rejects("負責人要是專案成員(400)", () => Parts.setHold(aPm, pm.id, flow, { reason: "X", owner: randomUUID() }), 400);
    await rejects("完成日期不能早於卡關日期(400)", () => Parts.resolveHold(aPm, pm.id, flow, "2026-02-01"), 400);
    await Parts.setHold(aPm, pm.id, flow, { reason: "待RD圖面進版", since: "2026-03-10", owner: rd.id });
    const d1 = await Parts.partDetail(aPm, flow);
    ok("換原因 → 舊的一筆結案進歷史", d1.holds.length === n0 + 1 && d1.holds.some((h) => h.reason === "廠商停產" && h.resolved === "2026-03-10" && h.owner_name !== ""));
    await Parts.resolveHold(aPm, pm.id, flow, "2026-03-20");
    const d2 = await Parts.partDetail(aPm, flow);
    ok("解除卡關 → 欄位清空、回到日期推的階段", d2.part.hold_reason === "" && d2.part.hold_since == null && d2.part.ev.phase !== "hold_ec" && d2.part.ev.phase !== "hold_issue", d2.part.ev.phase);
    ok("歷史多了兩筆(含完成日期)", d2.holds.length === n0 + 2 && d2.holds.some((h) => h.reason === "待RD圖面進版" && h.started === "2026-03-10" && h.resolved === "2026-03-20"));
    await rejects("沒在卡關不能解除(400)", () => Parts.resolveHold(aPm, pm.id, flow, "2026-03-21"), 400);
    // 表格上直接改原因:卡關日期 = 今天
    await Parts.updatePartField(aPm, pm.id, flow, "hold_reason", "ISSUE");
    const r3 = (await Parts.listParts(project.id)).find((x) => x.id === flow);
    ok("表格直接改原因 → 有卡關日期", r3.hold_reason === "ISSUE" && Boolean(r3.hold_since));
    await Parts.updatePartField(aPm, pm.id, flow, "hold_reason", "");
    const d3 = await Parts.partDetail(aPm, flow);
    ok("表格清掉原因 → 這筆也進歷史", d3.part.hold_reason === "" && d3.holds.length === n0 + 3);
  }

  section("即時通知");
  const kinds = (ev) => ev.map((e) => e.kind).join();
  const evStart = await Parts.updatePartField(aPm, pm.id, flow, "pa_start", "2026-02-01");
  ok("填發起 → 通知 Sourcer", kinds(evStart) === "start", kinds(evStart));
  const toStart = await Notify.planNotices(project.id, pm.id, evStart);
  ok("Sourcer(有 email 的真實帳號)收得到", toStart.some((n) => n.user_id === real.id && n.groups[0].kind === "start"));
  // 被邀請、還沒建帳號的人預約了 owner → 通知直接寄到邀請的信箱,不再整組一起收
  await db.run("insert into pa_pending_owners (part_id, field, email) values (?,?,?)", [flow, "sourcer_owner", "Pending.User@example.com"]);
  const toPending = await Notify.planNotices(project.id, pm.id, evStart);
  ok("預約的 owner 收得到(信箱寄到邀請的地址)", toPending.length === 1 && toPending[0].email === "Pending.User@example.com" && toPending[0].user_id.startsWith("pending:"), JSON.stringify(toPending.map((n) => n.email)));
  ok("表格那一列帶著預約的 owner", (await Parts.listParts(project.id)).find((x) => x.id === flow)?.pending_owner?.sourcer_owner?.email === "Pending.User@example.com");
  await db.run("delete from pa_pending_owners where part_id = ?", [flow]);
  await rejects("RD owner 選了已失效／不存在的邀請 → 400", () => Parts.updatePartField(aPm, pm.id, flow, "rd_owner", "invite:00000000-0000-4000-8000-000000000000"), 400);
  await rejects("owner 填亂字 → 400", () => Parts.updatePartField(aPm, pm.id, flow, "rd_owner", "abc"), 400);
  // PM Head:看得到所有專案(唯讀),沒有專案角色就改不了東西
  const head = { id: "00000000-0000-4000-8000-0000000000aa", email: "head@example.com", name: "Head", account_role: "pm_head", isAdmin: false, canViewAll: true };
  const aHead = await P.access(project.id, head);
  ok("PM Head 不是成員也看得到專案", aHead.project.id === project.id && aHead.roles.length === 0 && !aHead.canManage);
  ok("PM Head 的專案清單含這個專案", (await P.listProjects(head)).some((x) => x.id === project.id));
  await rejects("PM Head 不能改欄位(403)", () => Parts.updatePartField(aHead, head.id, flow, "part_type", "標準件"), 403);
  await rejects("沒有專案角色的人(PM Head／團隊主管)不能標卡關(403)", () => Parts.setHold(aHead, head.id, flow, { reason: "X" }), 403);
  const aTeamHead = await P.access(project.id, { ...head, account_role: "team_head" });
  ok("團隊主管看得到專案但沒有專案角色", aTeamHead.project.id === project.id && aTeamHead.roles.length === 0);
  await rejects("一般帳號不是成員 → 看不到(404)", () => P.access(project.id, { ...head, account_role: "user", canViewAll: false }), 404);
  ok("自己做的事不寄給自己", (await Notify.planNotices(project.id, real.id, evStart)).length === 0);
  ok("改發起日期不再通知", (await Parts.updatePartField(aPm, pm.id, flow, "pa_start", "2026-02-02")).length === 0);
  await Parts.updatePartField(aSourcer, sourcer.id, flow, "supplier_notified", "2026-02-03");
  const evDocs = await Parts.updatePartField(aSourcer, sourcer.id, flow, "docs_received", "2026-02-05");
  ok("填收齊 → 通知 QA", kinds(evDocs) === "docs", kinds(evDocs));
  ok("Sourcer 不會收到收齊通知", !(await Notify.planNotices(project.id, sourcer.id, evDocs)).some((n) => n.user_id === real.id));
  await P.setMemberRoles(aPm, real.id, ["sourcer", "qa"]);
  ok("QA 收得到收齊通知", (await Notify.planNotices(project.id, sourcer.id, evDocs)).some((n) => n.user_id === real.id));
  await P.setMemberRoles(aPm, real.id, ["sourcer"]);
  const escalations = [];
  for (let i = 0; i < ESCALATE_AT + 1; i++) await Parts.addIssue(aRd, rd.id, flow, "RD", `2026-02-${String(6 + i).padStart(2, "0")}`, "", escalations);
  ok(`第 ${ESCALATE_AT} 次退件才通知 PM、之後不再通知`, kinds(escalations) === "escalate:RD", kinds(escalations));
  const evRd = await Parts.updatePartField(aRd, rd.id, flow, "rd_pass", "2026-02-15");
  ok("只有 RD pass 還不算", evRd.length === 0);
  const evQa = await Parts.updatePartField(aAdmin, real.id, flow, "qa_pass", "2026-02-16");
  ok("RD、QA 都 pass → 通知 Sourcer 上 PLM", kinds(evQa) === "approved", kinds(evQa));
  const bulkEv = [];
  await Parts.updatePartsField(aPm, pm.id, [blank[1].id, blank[2].id], "pa_start", "2026-02-01", bulkEv);
  ok("批次填發起 → 每顆料一個通知", bulkEv.length === 2);
  const grouped = await Notify.planNotices(project.id, pm.id, bulkEv);
  ok("同一個收件人只收一封、裡面列兩顆", grouped.find((n) => n.user_id === real.id)?.groups[0].parts.length === 2);
  const html2 = grouped[0] ? Notify.renderNotice(grouped[0], { id: project.id, name: "檢查用專案" }).html : "";
  ok("通知信有連結", html2.includes(`/pa/p/${project.id}`));
  await Notify.sendNotices(project.id, pm.id, bulkEv);
  await Notify.sendNotices(project.id, pm.id, bulkEv);
  const logged = await db.all("select 1 from pa_notify_log where part_id = any(?::text[])", [[blank[1].id, blank[2].id]]);
  ok("同一件事只記一次(不會重寄)", logged.length === 2, `${logged.length} 筆`);
  await Parts.updatePartField(aSourcer, sourcer.id, flow, "plm_upload", "2026-02-17");
  ok("上傳 PLM → PLM簽核", (await Parts.partRow(aPm, flow)).ev.phase === "plm_signing");
  await Parts.updatePartField(aSourcer, sourcer.id, flow, "plm_released", "2026-02-20");
  ok("Released → 已完成", (await Parts.partRow(aPm, flow)).ev.phase === "done");

  // ---------- 個人連線金鑰(map_system 用) ----------
  section("RD owner、承認樣品、圖面 Release");
  const ow = blank[3].id;
  await rejects("RD owner 要是 RD(PM 不行,400)", () => Parts.updatePartField(aPm, pm.id, ow, "rd_owner", pm.id), 400);
  await Parts.updatePartField(aPm, pm.id, ow, "rd_owner", rd.id);
  ok("指定得了 RD owner", (await Parts.partRow(aPm, ow)).rd_owner === rd.id);
  await Parts.updatePartField(aSourcer, sourcer.id, ow, "rd_owner", "");
  ok("Sourcer 也能改 RD owner(兩個 owner 欄大家都能改)", true);
  // 把某人移出 RD 角色 → 料上指定他的 RD owner 一併清掉(不留「已不是成員」)。要用有真帳號的 real
  const realRoles = (await P.listMembers(project.id)).find((m) => m.user_id === real.id)?.roles ?? [];
  await P.setMemberRoles(aPm, real.id, [...new Set([...realRoles, "rd"])]);
  await Parts.updatePartField(aPm, pm.id, ow, "rd_owner", real.id);
  await P.setMemberRoles(aPm, real.id, realRoles.filter((r) => r !== "rd"));
  ok("移出 RD 角色 → RD owner 自動清掉", (await Parts.partRow(aPm, ow)).rd_owner === "");
  await P.setMemberRoles(aPm, real.id, realRoles);
  await rejects("RD 不能填承認樣品(403)", () => Parts.updatePartField(aRd, rd.id, ow, "sample_received", "2026-02-01"), 403);
  await Parts.updatePartField(aSourcer, sourcer.id, ow, "sample_received", "2026-02-01");
  await Parts.updatePartField(aSourcer, sourcer.id, ow, "drawing_release", "2026-02-01");
  ok("Sourcer 也能填圖面 Release", (await Parts.partRow(aPm, ow)).drawing_release === "2026-02-01");
  await Parts.updatePartField(aRd, rd.id, ow, "drawing_release", "2026-02-02");
  const owRow = await Parts.partRow(aPm, ow);
  ok("承認樣品／圖面 Release 存得進去", owRow.sample_received === "2026-02-01" && owRow.drawing_release === "2026-02-02");
  const { routeTo } = await import("../src/lib/pa.ts");
  const mem = [{ user_id: "a", role: "rd" }, { user_id: "b", role: "rd" }, { user_id: "c", role: "qa" }];
  ok("有 RD owner → RD 的事只給他", routeTo("rd", { sourcer_owner: "", rd_owner: "b" }, mem).map((m) => m.user_id).join() === "b");
  ok("沒指定 → 整組 RD", routeTo("rd", { sourcer_owner: "", rd_owner: "" }, mem).length === 2);
  ok("RD owner 不影響 QA", routeTo("qa", { sourcer_owner: "", rd_owner: "b" }, mem).map((m) => m.user_id).join() === "c");
  ok("owner 已不是那個角色 → 退回整組", routeTo("rd", { sourcer_owner: "", rd_owner: "zz" }, mem).length === 2);

  section("退件後：供應商更新資料");
  const sl = await P.getSla(project.id);
  ok("供應商更新 SLA 預設 7 天", sl.supplier_update === 7);
  await rejects("SLA 只有系統管理員能改(PM 不行,403)", () => P.setGlobalSla(pm, { supplier_update: 5 }), 403);
  await rejects("SLA 天數要是 0–365 的整數(400)", () => P.setGlobalSla(sysadmin, { supplier_update: 1.5 }), 400);
  await P.setGlobalSla(sysadmin, { supplier_update: 5 });
  ok("系統管理員改得了,而且是全公司一套", (await P.getSla(project.id)).supplier_update === 5 && (await P.getSla()).supplier_update === 5);
  const st0 = (await Parts.projectStats([project.id], () => [], "2026-02-12")).get(project.id);
  ok("首頁統計也吃全公司 SLA", st0 !== undefined);
  const su = blank[4].id;
  await Parts.updatePartField(aPm, pm.id, su, "pa_start", "2026-02-01");
  await Parts.updatePartField(aSourcer, sourcer.id, su, "supplier_notified", "2026-02-02");
  await Parts.updatePartField(aSourcer, sourcer.id, su, "docs_received", "2026-02-03");
  await Parts.updatePartField(aRd, rd.id, su, "rd_pass", "2026-02-04");
  await P.setMemberRoles(aPm, real.id, ["sourcer", "qa"]);
  const aQa = await P.access(project.id, sysadmin);
  const qi = await Parts.addIssue(aQa, real.id, su, "QA", "2026-02-10", "RoHS 報告過期");
  const rowWait = (await Parts.listParts(project.id, "2026-02-12")).find((x) => x.id === su);
  ok("QA 退件後 → 等供應商(剩 3 天)", rowWait.ev.supplier_update.dept === "QA" && rowWait.ev.supplier_update.dueIn === 3, JSON.stringify(rowWait.ev.supplier_update));
  ok("階段是被QA退件,負責的也輪到 QA", rowWait.ev.phase === "rework_qa" && rowWait.ev.waitingOn.includes("qa"), rowWait.ev.phase);
  ok("輪到 Sourcer", rowWait.ev.waitingOn.includes("sourcer"));
  const rowLate = (await Parts.listParts(project.id, "2026-02-20")).find((x) => x.id === su);
  ok("超過 SLA → 紅燈", rowLate.ev.supplier_update.light === "red" && rowLate.ev.supplier_update.overBy === 5);
  ok("算進逾期", rowLate.ev.red > 0);
  ok("等供應商補件期間 QA pass 不算逾期(暫停)", rowLate.ev.qa_pass.light === null && rowLate.ev.qa_pass.dueIn === null, JSON.stringify(rowLate.ev.qa_pass));
  const dg = (await Digest.buildDigests("2026-02-20")).find((d) => d.user_id === real.id);
  ok("每日信寄給 Sourcer", dg?.projects.some((x) => x.items.some((i) => i.part_id === su && i.stage.startsWith("供應商更新"))) ?? false);
  await rejects("RD 不能填 QA 退件的供應商更新(403)", () => Parts.setIssueResubmitted(aRd, rd.id, qi.id, "2026-02-15"), 403);
  await rejects("更新日不能早於退件日(400)", () => Parts.setIssueResubmitted(aSourcer, sourcer.id, qi.id, "2026-02-01"), 400);
  await Parts.setIssueResubmitted(aSourcer, sourcer.id, qi.id, "2026-02-15");
  ok("補件後複審 SLA 預設 3 天", (await P.getSla()).rereview === 3);
  const rowRr = (await Parts.listParts(project.id, "2026-02-17")).find((x) => x.id === su);
  ok("補件後 → QA 複審倒數(剩 1 天)", rowRr.ev.rereview.dept === "QA" && rowRr.ev.rereview.dueIn === 1, JSON.stringify(rowRr.ev.rereview));
  ok("補件後 QA pass 期限從供應商更新日重算、天數用補件後複審的 3 天(剩 1 天)", rowRr.ev.qa_pass.dueIn === 1 && rowRr.ev.qa_pass.light === null, JSON.stringify(rowRr.ev.qa_pass));
  const rowRrLate = (await Parts.listParts(project.id, "2026-02-20")).find((x) => x.id === su);
  ok("補件超過 3 天沒審 → 紅燈 2 天", rowRrLate.ev.rereview.light === "red" && rowRrLate.ev.rereview.overBy === 2, JSON.stringify(rowRrLate.ev.rereview));
  ok("輪到 QA", rowRrLate.ev.waitingOn.includes("qa"));
  const dgRr = (await Digest.buildDigests("2026-02-20")).find((d) => d.user_id === real.id);
  ok("每日信寄給 QA(QA pass,補件後 3 天)", dgRr?.projects.some((x) => x.items.some((i) => i.part_id === su && i.stage === "QA pass" && i.sla === 3)) ?? false);
  const rowBack = (await Parts.listParts(project.id, "2026-02-20")).find((x) => x.id === su);
  ok("供應商更新後 → 回到待QA審核", rowBack.ev.phase === "review_qa" && rowBack.ev.supplier_update.dept === null, rowBack.ev.phase);
  ok("表格那一列帶著更新日", rowBack.issues.find((i) => i.dept === "QA")?.resubmitted === "2026-02-15");
  const st = (await Parts.projectStats([project.id], () => [], "2026-02-20")).get(project.id);
  ok("首頁統計也認得供應商已更新", (st.phases.review_qa ?? 0) >= 1);
  await Parts.setIssueResubmitted(aSourcer, sourcer.id, qi.id, null);
  const rowPend = (await Parts.partRow(aPm, su)).ev;
  ok("清掉之後又在等供應商", rowPend.supplier_update.dept === "QA");
  await Parts.updatePartField(aSourcer, sourcer.id, su, "supplier_updated", "2026-02-16");
  const rowFilled = (await Parts.partRow(aPm, su, "2026-02-17")).ev;
  ok("Sourcer 回填供應商更新資料日期 → 不再等供應商", rowFilled.supplier_update.dept === null);
  ok("回填後 QA pass 從那天重算、用補件後複審 3 天(剩 2 天)", rowFilled.qa_pass.dueIn === 2 && rowFilled.qa_pass.light === null, JSON.stringify(rowFilled.qa_pass));
  await rejects("RD 不能填供應商更新資料日期(403)", () => Parts.updatePartField(aRd, rd.id, su, "supplier_updated", "2026-02-16"), 403);
  // 還沒填「收齊資料」就回填供應商更新日期 → 收齊資料一併填成同一天、階段進待QA審核、通知 QA
  const sd = blank[5].id;
  await Parts.updatePartField(aPm, pm.id, sd, "pa_start", "2026-02-01");
  await Parts.updatePartField(aSourcer, sourcer.id, sd, "supplier_notified", "2026-02-02");
  const evSd = await Parts.updatePartField(aSourcer, sourcer.id, sd, "supplier_updated", "2026-02-10");
  const rowSd = await Parts.partRow(aPm, sd, "2026-02-11");
  ok("回填供應商更新日期 → 收齊資料自動填同一天", rowSd.docs_received === "2026-02-10", String(rowSd.docs_received));
  ok("階段進到待QA審核", rowSd.ev.phase === "review_qa", rowSd.ev.phase);
  ok("通知 QA(收齊)", evSd.some((e) => e.kind === "docs"), JSON.stringify(evSd));
  // 退件之後又填了「收齊資料」(資料重新收齊再通知 QA)→ 也算供應商已送回
  await Parts.updatePartField(aSourcer, sourcer.id, su, "docs_received", "2026-02-18");
  const rowDocs = (await Parts.partRow(aPm, su, "2026-02-19")).ev;
  ok("退件後重填收齊資料 → 不再等供應商、QA 複審從那天算(剩 2 天)", rowDocs.supplier_update.dept === null && rowDocs.qa_pass.dueIn === 2, JSON.stringify(rowDocs.qa_pass));
  await Parts.updatePartField(aSourcer, sourcer.id, su, "docs_received", "2026-02-03");
  // 同一天內誰先誰後:先填「供應商更新」、之後 QA 才記退件 → 還在等供應商;反過來(退件在前、更新在後)→ 已送回
  const sdA = blank[6].id, sdB = blank[7].id;
  for (const id of [sdA, sdB]) {
    await Parts.updatePartField(aPm, pm.id, id, "pa_start", "2026-02-01");
    await Parts.updatePartField(aSourcer, sourcer.id, id, "supplier_notified", "2026-02-02");
    await Parts.updatePartField(aSourcer, sourcer.id, id, "docs_received", "2026-02-03");
  }
  await Parts.updatePartField(aSourcer, sourcer.id, sdA, "supplier_updated", "2026-02-10");
  await Parts.addIssue(aQa, real.id, sdA, "QA", "2026-02-10", "資料不全");
  ok("同一天:先填更新、後記退件 → 還在等供應商(被退件)", (await Parts.partRow(aPm, sdA, "2026-02-11")).ev.phase === "rework_qa", (await Parts.partRow(aPm, sdA, "2026-02-11")).ev.phase);
  await Parts.addIssue(aQa, real.id, sdB, "QA", "2026-02-10", "資料不全");
  await Parts.updatePartField(aSourcer, sourcer.id, sdB, "supplier_updated", "2026-02-10");
  ok("同一天:先記退件、後填更新 → 已送回(待QA審核)", (await Parts.partRow(aPm, sdB, "2026-02-11")).ev.phase === "review_qa", (await Parts.partRow(aPm, sdB, "2026-02-11")).ev.phase);
  // 沒有 RD owner 的料:QA pass → 直接「可上PLM」並通知 Sourcer(不通知 RD 去審)
  const noRd = blank[8].id;
  await Parts.updatePartField(aPm, pm.id, noRd, "pa_start", "2026-02-01");
  await Parts.updatePartField(aSourcer, sourcer.id, noRd, "supplier_notified", "2026-02-02");
  await Parts.updatePartField(aSourcer, sourcer.id, noRd, "docs_received", "2026-02-03");
  const evNoRd = await Parts.updatePartField(aQa, real.id, noRd, "qa_pass", "2026-02-05");
  const rowNoRd = (await Parts.partRow(aPm, noRd, "2026-02-06")).ev;
  ok("沒有 RD owner:QA pass → 可上PLM", rowNoRd.phase === "plm_ready" && rowNoRd.approved, rowNoRd.phase);
  ok("通知 Sourcer 可上 PLM、不通知 RD", evNoRd.map((e) => e.kind).join() === "approved", evNoRd.map((e) => e.kind).join());
  ok("RD pass 那一階不逾期、輪不到 RD", rowNoRd.rd_pass.light === null && !rowNoRd.waitingOn.includes("rd"));
  await Parts.updatePartField(aSourcer, sourcer.id, su, "supplier_updated", "");
  ok("清掉 → 又在等供應商", (await Parts.partRow(aPm, su)).ev.supplier_update.dept === "QA");
  await P.setMemberRoles(aPm, real.id, ["sourcer"]);

  section("個人畫面設定（跟著帳號走）");
  const Prefs = await import("../src/server/pa/prefs.ts");
  await rejects("不收亂七八糟的鍵(400)", () => Prefs.setPref(sysadmin, "anything", "{}"), 400);
  await rejects("不收壞掉的 JSON(400)", () => Prefs.setPref(sysadmin, "pa-col-widths", "{oops"), 400);
  const before = await Prefs.getPrefs(sysadmin);
  await Prefs.setPref(sysadmin, "pa-col-widths", JSON.stringify({ part_pn: 150 }));
  await Prefs.setPref(sysadmin, "pa-col-widths", JSON.stringify({ part_pn: 160 }));
  ok("存得進去、再存是覆蓋", (await Prefs.getPrefs(sysadmin))["pa-col-widths"] === JSON.stringify({ part_pn: 160 }));
  ok("別人看不到我的設定", Object.keys(await Prefs.getPrefs(pm)).length === 0);
  // 這裡是暫時 schema,但 profiles 是真的帳號:測完還原,免得留下測試值
  if (before["pa-col-widths"] === undefined) await db.run("delete from pa_user_prefs where user_id = ?", [real.id]);

  section("個人連線金鑰");
  const Tokens = await import("../src/server/pa/tokens.ts");
  const Auth = await import("../src/server/pa/auth.ts");
  const made = await Tokens.createToken(sysadmin, "檢查用");
  ok("金鑰長得對", made.token.startsWith("pa_") && made.token.length > 40);
  const stored = await db.get("select token_hash from pa_api_tokens where id = ?", [made.info.id]);
  ok("資料庫只存雜湊", stored && stored.token_hash !== made.token && stored.token_hash.length === 64);
  const viaPat = await Auth.userFromToken(made.token);
  ok("用金鑰認得出是誰", viaPat?.id === real.id && viaPat?.viaToken === true);
  ok("記下最後使用時間", Boolean((await Tokens.listTokens(sysadmin)).find((x) => x.id === made.info.id)?.last_used_at));
  await rejects("用金鑰不能再開金鑰(403)", () => Tokens.createToken(viaPat, "偷開"), 403);
  ok("亂打的金鑰認不得", (await Tokens.userFromApiToken("pa_" + "x".repeat(43))) === null);
  await rejects("非管理者不能管金鑰(403)", () => Tokens.revokeToken(pm, made.info.id), 403);
  await rejects("非管理者不能開金鑰(403)", () => Tokens.createToken(pm, "偷開"), 403);
  await Tokens.revokeToken(sysadmin, made.info.id);
  ok("撤銷後立刻失效", (await Tokens.userFromApiToken(made.token)) === null);
  await db.run("delete from pa_api_tokens where id = ?", [made.info.id]);

  // ---------- 匯出 ----------
  section("匯出 Excel");
  const xlsx = await Bom.exportXlsx(aPm);
  ok("匯得出檔案", xlsx.length > 5000, `${xlsx.length} bytes`);
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx);
  const ws = wb.getWorksheet("PA tracker");
  ok("工作表在", Boolean(ws));
  ok("表頭第一欄是成品料號", ws.getRow(1).getCell(1).value === "成品料號");
  ok("資料列數對得上", ws.rowCount - 1 === (await Parts.listParts(project.id)).length, `${ws.rowCount - 1}`);
  let redCells = 0;
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    if (n === 1) return;
    row.eachCell({ includeEmpty: true }, (c) => {
      if (c.fill?.fgColor?.argb === "FFFF8A80") redCells++;
    });
  });
  ok("逾期的格子有標紅", redCells > 0, `${redCells} 格`);
  ok("SLA 工作表在", Boolean(wb.getWorksheet("SLA 與狀態")));
  const sumWs = wb.getWorksheet("階段統計");
  ok("階段統計工作表在", Boolean(sumWs));
  const heads = [];
  ws.getRow(1).eachCell((c) => heads.push(String(c.value)));
  ok("匯出沒有 Status 欄(只留階段)", !heads.includes("Status") && heads.includes("階段"));
  ok("匯出有 RD owner／承認樣品／圖面 Release", ["RD owner", "承認樣品", "圖面 Release"].every((h) => heads.some((x) => x.startsWith(h))));
  ok("階段統計合計 = 料號數", sumWs?.getRow(sumWs.rowCount).getCell(2).value === (await Parts.listParts(project.id)).filter((p) => !p.removed_from_bom).length);

  // ---------- 每日逾期信 ----------
  section("每日逾期信");
  const digests = await Digest.buildDigests(today);
  const mine = digests.find((d) => d.user_id === real.id);
  ok("寄給有逾期項目的成員", Boolean(mine), `${digests.length} 個人有逾期`);
  ok("只列他自己負責的階段", mine?.projects.every((p) => p.items.every((i) => i.role === "sourcer")) ?? false);
  const html = mine ? Digest.renderDigest(mine, today).html : "";
  ok("信裡有專案名稱與連結", html.includes("檢查用專案") && html.includes(`/pa/p/${project.id}`));
  ok("沒有角色的人不會收到信", !digests.some((d) => d.user_id === outsider.id));
  const sent = await Digest.sendDigests(today);
  ok("SMTP 沒設定就不寄", sent.sent === 0);

  // ---------- 收尾 ----------
  section("收尾");
  await P.updateProject(aPm, { archived: true });
  ok("封存的專案不進每日信", (await Digest.buildDigests(today)).length === 0);
  await db.run("delete from pa_projects where id = ?", [project.id]);
  ok("刪專案會連帶刪掉底下的料", (await db.all("select 1 from pa_parts where project_id = ?", [project.id])).length === 0);
}

try {
  await main();
} catch (e) {
  failures++;
  console.error("\n✗ 例外:", e);
} finally {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* Windows 上 SQLite 檔還被這個行程開著:交給系統清暫存 */
  }
}

console.log(`\n${failures ? `FAIL(${failures})` : "PASS"}`);
process.exit(failures ? 1 : 0);
