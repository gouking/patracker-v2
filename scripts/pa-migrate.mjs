// 把本機那套 PA Tracker(patracker,node:sqlite)的資料搬進這裡的 Postgres。
//
// 單向複製,可以重複執行:同一個專案 id 再跑一次就是整批覆蓋(先刪掉那個專案底下的
// 所有資料再寫回去),所以本機那邊繼續改、隨時可以再同步一次。
//
// 帳號用 email 對應:本機是 trackly.db 的 users,這裡是 public.profiles。
// 對不到的(例如已經離職的人、或匯入時寫的 "import")原樣保留,畫面上會顯示成
// 「(已刪除的帳號)」,不影響資料。
//
// 跑法:
//   DATABASE_URL="postgresql://…" node --experimental-strip-types scripts/pa-migrate.mjs [--commit]
// 不加 --commit 就只印出會搬什麼,不寫入。

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const PA_DB = process.env.PATRACKER_DB || "D:/Claude/patracker/data/patracker.db";
const TRACKLY_DB = process.env.TRACKLY_DB || "D:/Claude/trackly/data/trackly.db";
const CONN = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!CONN) {
  console.error("要有 DATABASE_URL(Postgres 連線字串)");
  process.exit(1);
}
if (!existsSync(PA_DB)) {
  console.error(`找不到本機的 patracker.db:${PA_DB}`);
  process.exit(1);
}

const TABLES = [
  ["projects", "pa_projects"],
  ["project_members", "pa_project_members"],
  ["sla_settings", "pa_sla_settings"],
  ["parts", "pa_parts"],
  ["review_issues", "pa_review_issues"],
  ["part_history", "pa_part_history"],
];

const src = new DatabaseSync(PA_DB, { readOnly: true });
const rows = (sql, params = []) => src.prepare(sql).all(...params).map((r) => ({ ...r }));

// ---------- 帳號對應 ----------
const userMap = new Map();
const client = new pg.Client({
  connectionString: CONN,
  ssl: /^(localhost|127\.0\.0\.1)/.test(new URL(CONN).hostname) ? undefined : { rejectUnauthorized: false },
});
await client.connect();

const { rows: profiles } = await client.query("select id, email from public.profiles");
const byEmail = new Map(profiles.map((p) => [String(p.email).toLowerCase(), p.id]));
if (existsSync(TRACKLY_DB)) {
  const t = new DatabaseSync(TRACKLY_DB, { readOnly: true });
  for (const u of t.prepare("select id, email from users").all()) {
    const to = byEmail.get(String(u.email).toLowerCase());
    if (to) userMap.set(String(u.id), to);
    else console.log(`  ! 本機帳號 ${u.email} 在這裡沒有對應的 profile,id 原樣保留`);
  }
}
const mapUser = (id) => userMap.get(String(id)) ?? String(id);

// ---------- 要搬的東西 ----------
const projects = rows("select * from projects");
console.log(`本機有 ${projects.length} 個專案:`);
for (const p of projects) {
  const n = rows("select count(*) as n from parts where project_id = ?", [p.id])[0].n;
  const m = rows("select count(*) as n from project_members where project_id = ?", [p.id])[0].n;
  console.log(`  ${p.name}（${p.id}）— ${n} 顆料、${m} 筆成員角色`);
}
console.log(`帳號對應:${userMap.size} 個對得上`);

if (!COMMIT) {
  console.log("\n這是預覽。加上 --commit 才會真的寫入。");
  await client.end();
  process.exit(0);
}

// ---------- 寫入 ----------
const cols = async (table) => {
  const { rows: r } = await client.query(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1",
    [table]
  );
  return new Set(r.map((x) => x.column_name));
};

const USER_COLS = new Set(["created_by", "user_id"]);

await client.query("begin");
try {
  for (const p of projects) {
    // 同一個專案再搬一次 = 整批覆蓋
    await client.query("delete from pa_projects where id = $1", [p.id]);
  }
  let total = 0;
  for (const [from, to] of TABLES) {
    const target = await cols(to);
    const data = rows(`select * from ${from}`);
    for (const row of data) {
      // pa_part_history.id 是資料庫自己產的(identity),不要帶過去
      const keys = Object.keys(row).filter((k) => target.has(k) && !(to === "pa_part_history" && k === "id"));
      const vals = keys.map((k) => (USER_COLS.has(k) ? mapUser(row[k]) : row[k]));
      await client.query(
        `insert into ${to} (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
        vals
      );
      total++;
    }
    console.log(`  ${from} → ${to}:${data.length} 筆`);
  }
  await client.query("commit");
  console.log(`\n搬好了,共 ${total} 筆。`);
} catch (e) {
  await client.query("rollback");
  console.error("失敗,已回滾:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
