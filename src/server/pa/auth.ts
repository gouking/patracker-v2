// PA Tracker 的登入:自己的帳號(patracker.db 的 users),不依賴 Trackly。
//
// 登入後發 `pa_session` cookie;JWT 內帶 sid,每次都回 sessions 表查沒被撤銷、沒過期、
// 帳號沒停用才算數(account.ts)。使用者資料(名字、email、角色)走 db.ts 的 profiles view。
//
// 另外保留 web-gantt 版的「個人連線金鑰」(tokens.ts):別的程式(QA 電腦上的 map_system)
// 用 Authorization: Bearer pa_… 代表某個人呼叫。

import { db } from "./db";
import { SESSION_COOKIE, cookieValue, readSessionToken } from "./account";
import { TOKEN_PREFIX, userFromApiToken } from "./tokens";

export { SESSION_COOKIE };

export interface User {
  id: string;
  email: string;
  name: string;
  /** 系統角色:admin / pm_head / pm_leader / pm / user / trial(users.role) */
  account_role: string;
  isAdmin: boolean;
  /** 看得到所有專案(唯讀):系統管理員或 PM Head。能不能改仍看專案角色 */
  canViewAll?: boolean;
  /** 這次請求是用個人連線金鑰(tokens.ts)而不是網頁登入 */
  viaToken?: boolean;
}

interface ProfileRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

const toUser = (r: ProfileRow): User => ({
  id: r.id,
  email: r.email,
  name: r.name?.trim() || r.email.split("@")[0],
  account_role: r.role,
  isAdmin: r.role === "admin",
  canViewAll: r.role === "admin" || r.role === "pm_head",
});

export async function getUserById(id: string): Promise<User | null> {
  const r = await db.get<ProfileRow>("select id, email, name, role from profiles where id = ?", [id]);
  return r ? toUser(r) : null;
}

export async function getUsersByIds(ids: string[]): Promise<Map<string, User>> {
  const out = new Map<string, User>();
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return out;
  const rows = await db.all<ProfileRow>(
    `select id, email, name, role from profiles where id in (${uniq.map(() => "?").join(",")})`,
    uniq
  );
  for (const r of rows) out.set(r.id, toUser(r));
  return out;
}

export async function listAllUsers(): Promise<User[]> {
  const rows = await db.all<ProfileRow>("select id, email, name, role from profiles order by name, email");
  return rows.map(toUser);
}

// ---------- session ----------

async function userFromCookie(jwt: string): Promise<User | null> {
  const s = await readSessionToken(jwt);
  // 以資料庫目前的資料為準:帳號被刪掉,舊 cookie 立刻失效
  return s ? getUserById(s.userId) : null;
}

/** token → 這個人是誰。認不得就 null,由呼叫端回 401。 */
export async function userFromToken(token: string): Promise<User | null> {
  if (!token) return null;
  if (token.startsWith(TOKEN_PREFIX)) return userFromApiToken(token);
  return userFromCookie(token);
}

function bearer(req: Request): string {
  const auth = req.headers.get("authorization") || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

/** API route 用:先看個人連線金鑰(Authorization),沒有再看登入 cookie。 */
export async function apiUser(req: Request): Promise<User | null> {
  const b = bearer(req);
  if (b) return userFromToken(b);
  return userFromToken(cookieValue(req, SESSION_COOKIE));
}
