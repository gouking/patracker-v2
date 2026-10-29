// 個人連線金鑰:讓別的程式代表某個人呼叫 /api/pa/*。
//
// 第一個用途是 QA 電腦上的 map_system(零件承認文件審核):它從 PA Tracker 拉專案與料號,
// 審完再把「QA 開始 review／退件／pass」寫回來。走的是跟網頁一模一樣的 API 與權限檢查,
// 所以金鑰能做的事 = 那個人在網頁上能做的事,修改紀錄也記在那個人名下。
//
// 金鑰長這樣:pa_ + 43 個 base64url 字元(32 bytes 亂數)。資料庫只存 sha256,
// 原始字串只在建立當下回給使用者一次。

import { createHash, randomBytes } from "node:crypto";
import { db, newId, now } from "./db";
import { getUserById, type User } from "./auth";
import { HttpError } from "./projects";

export const TOKEN_PREFIX = "pa_";

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

export interface TokenInfo {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/** 用金鑰呼叫的請求不能再管理金鑰——外流的金鑰不該能幫自己續命或多開幾把 */
function requireBrowser(user: User) {
  if (user.viaToken) throw new HttpError(403, "連線金鑰不能用來管理金鑰，請在網頁上操作");
}

export async function listTokens(user: User): Promise<TokenInfo[]> {
  requireBrowser(user);
  return db.all<TokenInfo>(
    "select id, name, created_at, last_used_at from pa_api_tokens where user_id = ? and revoked = 0 order by created_at desc",
    [user.id]
  );
}

export async function createToken(user: User, name: string): Promise<{ token: string; info: TokenInfo }> {
  requireBrowser(user);
  const label = String(name ?? "").trim().slice(0, 60) || "連線金鑰";
  const count = await db.get<{ n: string }>("select count(*) as n from pa_api_tokens where user_id = ? and revoked = 0", [user.id]);
  if (Number(count?.n ?? 0) >= 10) throw new HttpError(400, "一個人最多 10 把金鑰，請先撤銷用不到的");
  const raw = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const info: TokenInfo = { id: newId(), name: label, created_at: now(), last_used_at: null };
  await db.run("insert into pa_api_tokens (id, user_id, name, token_hash, created_at) values (?,?,?,?,?)", [
    info.id, user.id, label, hash(raw), info.created_at,
  ]);
  return { token: raw, info };
}

export async function revokeToken(user: User, id: string): Promise<void> {
  requireBrowser(user);
  const r = await db.all("update pa_api_tokens set revoked = 1 where id = ? and user_id = ? and revoked = 0 returning id", [id, user.id]);
  if (!r.length) throw new HttpError(404, "找不到這把金鑰");
}

/** 金鑰 → 這個人是誰。撤銷的、帳號已刪除的都回 null。 */
export async function userFromApiToken(raw: string): Promise<User | null> {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  // 順手記下最後使用時間(一句做完,不另外多一趟)
  const row = await db.get<{ user_id: string }>(
    "update pa_api_tokens set last_used_at = ? where token_hash = ? and revoked = 0 returning user_id",
    [now(), hash(raw)]
  );
  if (!row) return null;
  // 帳號停用後,他的連線金鑰也跟著失效
  const active = await db.get("select 1 from users where id = ? and is_active = 1", [row.user_id]);
  if (!active) return null;
  const u = await getUserById(row.user_id);
  return u ? { ...u, viaToken: true } : null;
}
