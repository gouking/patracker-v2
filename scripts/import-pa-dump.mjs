// 把 web-gantt(Supabase / Postgres)每日備份裡的 pa_* 資料表倒進本機 patracker 的 SQLite。
//
// 這是「整份換掉」,不是合併:下面列出的每張表都會先清空再寫入。
// 對應的 Trackly 那邊用 trackly/scripts/import-pg-dump.mjs,兩支吃同一種 pg_dump 檔。
//
// 執行:
//   node --experimental-strip-types --no-warnings scripts/import-pa-dump.mjs <dump 檔> [--dry]
//   例:... D:\Claude\web-gantt-backups\daily\web-gantt_2026-10-23_0300.dump --dry
//   環境變數:DB_PATH(預設 data/patracker.db)、TRACKLY_DB(用來檢查使用者 id 對不對得上)、PG_BIN
//
// 使用者 id:PA 的 owner、成員、建立者存的都是 Supabase profiles.id。
// Trackly 的 import-pg-dump.mjs 匯入 users 時保留同一個 id,所以這邊的 id 原封不動就對得上;
// **前提是 Trackly 先用同一份備份匯入過**。跑完會列出對不到 Trackly 使用者的 id 供你檢查。
//
// 兩個日誌表(pa_digest_log / pa_notify_log / pa_supplier_chase_log)也會一起搬:
// 少了它們,新主機一啟動就會把「今天已寄過」的逾期信和即時通知再寄一次。
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PA_SCHEMA_STEPS } from "../src/server/pa/schema.ts";

const PG_BIN = process.env.PG_BIN || "C:\\Program Files\\PostgreSQL\\18\\bin";
const DB_FILE = path.resolve(process.env.DB_PATH || path.join("data", "patracker.db"));
const TRACKLY_DB = process.env.TRACKLY_DB || "D:/Claude/trackly/data/trackly.db";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const dumpFile = args.find((a) => !a.startsWith("--"));
if (!dumpFile) {
  console.error("用法: node --experimental-strip-types scripts/import-pa-dump.mjs <dump 檔> [--dry]");
  process.exit(2);
}

/** 匯入順序 = 外鍵順序。 */
const TABLES = [
  "pa_projects",
  "pa_project_members",
  "pa_sla_settings",
  "pa_parts",
  "pa_part_notes",
  "pa_review_issues",
  "pa_part_history",
  "pa_digest_log",
  "pa_notify_log",
  "pa_api_tokens",
  "pa_user_prefs",
  "pa_global_sla",
  "pa_suppliers",
  "pa_pending_owners",
  "pa_supplier_chase_log",
];

// ---------- 1. 備份檔 → 純文字 ----------

const tmp = path.join(os.tmpdir(), `pa-import-${Date.now()}.sql`);
console.log(`讀取 ${dumpFile}`);
execFileSync(path.join(PG_BIN, "pg_restore.exe"), ["--data-only", "-n", "public", "-f", tmp, dumpFile]);
const text = fs.readFileSync(tmp, "utf8");
fs.rmSync(tmp, { force: true });

function unescapeCopy(v) {
  if (v === "\\N") return null;
  return v.replace(/\\(.)/g, (_, c) =>
    c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c === "b" ? "\b" : c === "f" ? "\f" : c
  );
}

/** COPY 區塊照原樣拆出來:tab 分欄,\N 是 null,其餘照 Postgres 的跳脫規則。 */
function parseCopyBlocks(sql) {
  const out = new Map();
  const lines = sql.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^COPY public\.(\w+) \(([^)]*)\) FROM stdin;$/.exec(lines[i]);
    if (!m) continue;
    const cols = m[2].split(",").map((s) => s.trim());
    const rows = [];
    for (i++; i < lines.length && lines[i] !== "\\."; i++) {
      if (lines[i] === "") continue;
      rows.push(lines[i].split("\t").map(unescapeCopy));
    }
    out.set(m[1], { cols, rows });
  }
  return out;
}

const src = parseCopyBlocks(text);

// ---------- 2. 開目標資料庫(沒有就依 schema 建)----------

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const existed = fs.existsSync(DB_FILE);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backup = `${DB_FILE}.bak-${stamp}`;
if (existed && !dry) {
  fs.copyFileSync(DB_FILE, backup);
  console.log(`原本的資料庫已另存:${backup}`);
}

const db = new DatabaseSync(dry && !existed ? ":memory:" : DB_FILE);
db.exec("PRAGMA foreign_keys = OFF");
for (const step of PA_SCHEMA_STEPS) {
  if ("sql" in step) db.exec(step.sql);
  else {
    const { table, column, ddl } = step.addcol;
    if (!db.prepare(`pragma table_info(${table})`).all().some((c) => c.name === column)) {
      db.exec(`alter table ${table} add column ${ddl}`);
    }
  }
}

// ---------- 3. 規劃 ----------

const plan = [];
for (const t of TABLES) {
  const block = src.get(t);
  const have = new Set(db.prepare("select name from pragma_table_info(?)").all(t).map((c) => c.name));
  const cols = (block?.cols ?? []).filter((c) => have.has(c));
  const dropped = (block?.cols ?? []).filter((c) => !have.has(c));
  plan.push({ t, block, cols });
  console.log(
    `  ${t}: ${block ? block.rows.length : 0} 筆` +
      (block ? `,對得上 ${cols.length}/${block.cols.length} 欄` : "(備份裡沒有這張表)") +
      (dropped.length ? `,忽略欄位 ${dropped.join(",")}` : "")
  );
}

// ---------- 4. 使用者 id 檢查 ----------

const ids = new Map(); // id → 出現在哪些欄位
const note = (id, where) => {
  if (!id) return;
  if (!ids.has(id)) ids.set(id, new Set());
  ids.get(id).add(where);
};
for (const [t, ...fields] of [
  ["pa_project_members", "user_id"],
  ["pa_projects", "created_by"],
  ["pa_parts", "sourcer_owner", "rd_owner"],
  ["pa_part_notes", "created_by"],
  ["pa_review_issues", "created_by"],
  ["pa_part_history", "user_id"],
  ["pa_api_tokens", "user_id"],
  ["pa_user_prefs", "user_id"],
]) {
  const p = plan.find((x) => x.t === t);
  if (!p?.block) continue;
  for (const f of fields) {
    const i = p.block.cols.indexOf(f);
    if (i < 0) continue;
    for (const r of p.block.rows) note(r[i], `${t}.${f}`);
  }
}
let known = null;
if (fs.existsSync(TRACKLY_DB)) {
  const trk = new DatabaseSync(TRACKLY_DB, { readOnly: true });
  known = new Set(trk.prepare("select id from users").all().map((r) => r.id));
  trk.close();
}
if (known) {
  const missing = [...ids].filter(([id]) => !known.has(id));
  console.log(`\n使用者 id 檢查:共 ${ids.size} 個,Trackly(${TRACKLY_DB})裡找不到 ${missing.length} 個`);
  for (const [id, where] of missing.slice(0, 10)) console.log(`  ${id}  ← ${[...where].join(", ")}`);
  if (missing.length) console.log("  → 多半是 Trackly 還沒用同一份備份匯入;匯入後再跑一次。");
} else {
  console.log(`\n(找不到 ${TRACKLY_DB},略過使用者 id 檢查)`);
}

if (dry) {
  console.log("\n--dry:沒有寫入任何東西。");
  process.exit(0);
}

// ---------- 5. 寫入 ----------

const intCols = new Map();
db.exec("BEGIN IMMEDIATE");
try {
  for (const { t } of [...plan].reverse()) db.exec(`delete from ${t}`);
  for (const { t, block, cols } of plan) {
    if (!block || !block.rows.length) continue;
    const idx = new Map(block.cols.map((c, i) => [c, i]));
    const stmt = db.prepare(`insert into ${t} (${cols.join(",")}) values (${cols.map(() => "?").join(",")})`);
    for (const row of block.rows) {
      // 這幾張表的欄位在 Postgres 也是 text / integer(sql/add_pa_tracker.sql),不用轉型
      stmt.run(...cols.map((c) => {
        const v = row[idx.get(c)];
        return v !== null && /^(-?\d+)$/.test(v) && isIntCol(t, c) ? Number(v) : v;
      }));
    }
    console.log(`  寫入 ${t}: ${block.rows.length} 筆`);
  }
  // 外鍵檢查:有孤兒資料就整批取消
  const bad = db.prepare("pragma foreign_key_check").all();
  if (bad.length) throw new Error(`外鍵檢查不過:${JSON.stringify(bad.slice(0, 3))}`);
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.error("匯入失敗,資料庫沒有被改動:", e.message);
  if (existed) console.error(`可以從 ${backup} 還原。`);
  process.exit(1);
}

function isIntCol(t, c) {
  if (!intCols.has(t)) {
    intCols.set(t, new Set(db.prepare("select name, type from pragma_table_info(?)").all(t).filter((x) => /int/i.test(x.type)).map((x) => x.name)));
  }
  return intCols.get(t).has(c);
}

console.log("\n結果(筆數):");
for (const t of TABLES) {
  const n = db.prepare(`select count(*) as n from ${t}`).get().n;
  const expected = src.get(t)?.rows.length ?? 0;
  console.log(`  ${t}: ${n}${n === expected ? "" : `  ✗ 備份有 ${expected} 筆`}`);
}
