// 每日備份 patracker.db(PA 資料與帳號都在這一個檔)。
//
// 用 SQLite 的 VACUUM INTO 產生一份完整、一致的副本:網站開著、有人正在寫也沒關係,
// 不會像直接複製 .db 那樣漏掉還在 -wal 檔裡的資料。產生後跑 integrity_check,
// 壞的備份會刪掉並以錯誤結束(工作排程的「上次執行結果」會顯示非 0)。
//
// 執行(專案資料夾裡):npm run backup
//   設定(.env.local 或環境變數):
//     DB_PATH            與網站相同(預設 data/patracker.db)
//     PA_BACKUP_DIR      備份放哪(預設:專案旁邊的 patracker-backups 資料夾)
//     PA_BACKUP_KEEP     保留幾份(預設 30)
//
// 還原:停掉網站 → 把 data/patracker.db、-wal、-shm 移走 → 把備份檔複製成 data/patracker.db → 啟動。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");

const DB_PATH = process.env.DB_PATH || "patracker.db";
const dbFile = path.isAbsolute(DB_PATH) ? DB_PATH : path.join(process.cwd(), "data", DB_PATH);
const dir = path.resolve(process.env.PA_BACKUP_DIR || path.join("..", "patracker-backups"));
const keep = Math.max(1, Number(process.env.PA_BACKUP_KEEP) || 30);

if (!fs.existsSync(dbFile)) {
  console.error(`找不到資料庫:${dbFile}`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });

// 檔名用本機時間,一天跑多次也不會撞名
const d = new Date();
const p2 = (n) => String(n).padStart(2, "0");
const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
const out = path.join(dir, `patracker_${stamp}.db`);
if (fs.existsSync(out)) fs.rmSync(out);

const src = new DatabaseSync(dbFile, { readOnly: true });
src.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
src.close();

const chk = new DatabaseSync(out, { readOnly: true });
const ok = chk.prepare("pragma integrity_check").get();
const users = chk.prepare("select count(*) as n from users").get().n;
const parts = chk.prepare("select count(*) as n from pa_parts").get().n;
chk.close();
if (Object.values(ok)[0] !== "ok") {
  fs.rmSync(out, { force: true });
  console.error("備份檔檢查不過,已刪除:", ok);
  process.exit(1);
}
const mb = (fs.statSync(out).size / 1048576).toFixed(1);
console.log(`備份完成:${out}(${mb} MB,帳號 ${users}、料號 ${parts})`);

// 只清自己產生的檔,舊的先刪
const old = fs.readdirSync(dir).filter((f) => /^patracker_\d{4}-\d\d-\d\d_\d{4}\.db$/.test(f)).sort();
for (const f of old.slice(0, Math.max(0, old.length - keep))) {
  fs.rmSync(path.join(dir, f));
  console.log(`刪除舊備份:${f}`);
}
