// 把 sql/add_pa_tracker.sql(web-gantt 的 Postgres 版,已含後續所有 add_pa_*.sql)
// 轉成 SQLite 能執行的 src/server/pa/schema.ts。
//
// 轉換規則:
//   * `alter table X add column if not exists …` → 啟動時先查 pragma table_info,沒有才加
//   * `enable row level security`、`drop constraint`、`do $$ … $$`、最後的 select → 丟掉
//   * `bigint generated always as identity primary key` → `integer primary key autoincrement`
// 新增欄位時:先改 sql/add_pa_tracker.sql,再跑 node scripts/build-schema.mjs。
import fs from "node:fs";

const src = fs.readFileSync(new URL("../sql/add_pa_tracker.sql", import.meta.url), "utf8");
const noComments = src.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
// 先挖掉 do $$ … $$; 整塊(裡面有分號)
const flat = noComments.replace(/do\s+\$\$[\s\S]*?end\s+\$\$\s*;/gi, "");
const stmts = flat.split(";").map((s) => s.trim()).filter(Boolean);

const out = [];
for (const s of stmts) {
  const one = s.replace(/\s+/g, " ");
  if (/enable row level security/i.test(one)) continue;
  if (/drop constraint/i.test(one)) continue;
  if (/^select /i.test(one)) continue;
  const m = /^alter table (\w+) add column if not exists (\w+) (.+)$/i.exec(one);
  if (m) {
    out.push({ addcol: { table: m[1], column: m[2], ddl: `${m[2]} ${m[3]}` } });
    continue;
  }
  if (/^alter table/i.test(one)) throw new Error("沒處理到的 alter: " + one.slice(0, 80));
  out.push({ sql: s.replace(/bigint generated always as identity primary key/gi, "integer primary key autoincrement") });
}

// Trackly 沒有「邀請」功能(web-gantt 有 app_invites):留一張空表讓「預約 owner」那幾句 SQL
// 能執行、結果永遠是沒有待加入的人。Trackly 日後若做邀請,再改成讀它的資料表。
out.push({
  sql: `create table if not exists app_invites (
  id text primary key, email text not null, name text not null default '',
  pa_project_id text, pa_roles text not null default '', used_at text,
  expires_at text not null, created_at text not null
)`,
});

const body = `// 由 scripts/build-schema.mjs 從 sql/add_pa_tracker.sql 產生,請勿手改。
// 每一步都可重複執行(create if not exists / 欄位已存在就跳過)。

export type SchemaStep = { sql: string } | { addcol: { table: string; column: string; ddl: string } };

export const PA_SCHEMA_STEPS: SchemaStep[] = ${JSON.stringify(out, null, 2)};
`;
fs.writeFileSync(new URL("../src/server/pa/schema.ts", import.meta.url), body);
console.log(`${out.length} steps (${out.filter((o) => o.addcol).length} addcol)`);
