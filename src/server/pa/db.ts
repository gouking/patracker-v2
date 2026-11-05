// PA Tracker 的資料庫連線:Node 內建的 node:sqlite,零原生相依。
//
// 這支檔案取代 web-gantt 版(pg + Supabase)的 db.ts,對外介面完全一樣:
// all / get / run / tx 四個方法,全部回傳 Promise。底層 SQLite 是同步的,
// 這裡只是把結果包成 Promise,讓 src/server/pa/ 其他檔案一字不改。
//
// 帳號也在同一個檔案(users / sessions …,見 accountSchema.ts),不依賴 Trackly。
// 另建一個暫時的 view 叫 profiles —— web-gantt 的 SQL 都是對 public.profiles 查的,
// 有了這個 view 就不必改。
//
// 延遲初始化:模組載入時不開檔(next build 會逐一評估每個 route 模組)。
// Next 開發模式會重複載入模組 → 用 globalThis 快取單例。

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { PA_SCHEMA_STEPS } from "./schema";
import { ACCOUNT_ADD_COLS, ACCOUNT_SCHEMA } from "./accountSchema";

export interface Db {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /** 整包成功或整包不算。巢狀呼叫只認最外層。 */
  tx<T>(fn: (t: Db) => Promise<T>): Promise<T>;
}

const DB_PATH = process.env.DB_PATH || "patracker.db";

/** 這一版不需要外部資料庫連線,恆為 true(保留名稱是為了讓呼叫端不用改)。 */
export const paDbConfigured = true;

export function dataDir(): string {
  return path.join(process.cwd(), "data");
}

/**
 * web-gantt 的 SQL 是 Postgres 方言,這裡只補兩個機械式的差異,其餘的 SQL 直接改寫過了:
 *   * `::text[]` 這類型別轉換 → 拿掉(SQLite 不需要)
 *   * `now()` → ISO 8601 字串(欄位都是 text,跟 now() 同一種比法)
 *   * `= any(?)` 搭配陣列參數 → `in (?,?,…)`,陣列攤成多個參數(空陣列 → `in (null)`,永遠不成立)
 */
export function adapt(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  let outSql = "";
  const outParams: unknown[] = [];
  let pi = 0;
  const re = /=\s*any\(\s*\?\s*(?:::\w+(?:\[\])?)?\s*\)|\?/g;
  let last = 0;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    outSql += sql.slice(last, m.index);
    last = m.index + m[0].length;
    const v = params[pi++];
    if (m[0] === "?") {
      outSql += "?";
      outParams.push(v);
    } else {
      const arr = Array.isArray(v) ? v : [];
      outSql += arr.length ? `in (${arr.map(() => "?").join(",")})` : "in (null)";
      outParams.push(...arr);
    }
  }
  outSql += sql.slice(last);
  return {
    sql: outSql.replace(/::\w+(?:\[\])?/g, "").replace(/\bnow\(\)/gi, "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
    params: outParams,
  };
}

function open(): DatabaseSync {
  const abs = path.isAbsolute(DB_PATH) ? DB_PATH : path.join(dataDir(), DB_PATH);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const sqlite = new DatabaseSync(abs);
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA busy_timeout = 4000");
  for (const step of PA_SCHEMA_STEPS) {
    if ("sql" in step) {
      sqlite.exec(step.sql);
    } else {
      const { table, column, ddl } = step.addcol;
      const cols = sqlite.prepare(`pragma table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) sqlite.exec(`alter table ${table} add column ${ddl}`);
    }
  }

  sqlite.exec(ACCOUNT_SCHEMA);
  for (const { table, column, ddl } of ACCOUNT_ADD_COLS) {
    const cols = sqlite.prepare(`pragma table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) sqlite.exec(`alter table ${table} add column ${ddl}`);
  }
  sqlite.exec("create unique index if not exists app_invites_token_idx on app_invites (token_hash) where token_hash is not null");
  sqlite.exec("CREATE TEMP VIEW IF NOT EXISTS profiles AS SELECT id, email, name, role FROM main.users");
  return sqlite;
}

// node:sqlite 回傳 null-prototype 物件,直接傳給 client component 會被 React 擋下,
// 所以在這一層攤平成普通物件。
const plain = <T>(row: unknown): T =>
  (row === undefined || row === null ? row : { ...(row as object) }) as T;

function makeDb(sqlite: DatabaseSync): Db {
  let depth = 0;
  const self: Db = {
    async all<T>(sql: string, params: unknown[] = []) {
      const q = adapt(sql, params);
      const rows = sqlite.prepare(q.sql).all(...(q.params as never[])) as unknown[];
      return rows.map((r) => plain<T>(r));
    },
    async get<T>(sql: string, params: unknown[] = []) {
      const q = adapt(sql, params);
      return plain<T | undefined>(sqlite.prepare(q.sql).get(...(q.params as never[])));
    },
    async run(sql: string, params: unknown[] = []) {
      const q = adapt(sql, params);
      const r = sqlite.prepare(q.sql).run(...(q.params as never[]));
      return { changes: Number(r.changes) };
    },
    async tx<T>(fn: (t: Db) => Promise<T>): Promise<T> {
      if (depth > 0) return fn(self);
      depth++;
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const out = await fn(self);
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          sqlite.exec("ROLLBACK");
        } catch {
          /* 已經沒有交易了就算了 */
        }
        throw e;
      } finally {
        depth--;
      }
    },
  };
  return self;
}

/** 其他檔案要直接用 SQLite 連線時(例如 auth.ts 查 session)。 */
const g = globalThis as unknown as { __paSqlite?: DatabaseSync; __paDb?: Db };
export function sqliteConn(): DatabaseSync {
  return g.__paSqlite ?? (g.__paSqlite = open());
}
function conn(): Db {
  return g.__paDb ?? (g.__paDb = makeDb(sqliteConn()));
}

export const db: Db = {
  all: (sql, params) => conn().all(sql, params),
  get: (sql, params) => conn().get(sql, params),
  run: (sql, params) => conn().run(sql, params),
  tx: (fn) => conn().tx(fn),
};

/** 現在時間,ISO 8601。所有時間欄位都用這個格式存。 */
export const now = (): string => new Date().toISOString();

/** 新 id。 */
export const newId = (): string => crypto.randomUUID();
