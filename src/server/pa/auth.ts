// PA Tracker 的登入:完全沿用 Trackly 的帳號(跟舊的 patracker 同一套)。
//
// Trackly 登入後發 `trackly_session` cookie(掛在 .orblab.app),這裡用同一把 SESSION_SECRET
// 驗章;JWT 內帶 sid,每次都回 trackly.db 查 sessions 沒被撤銷、沒過期、帳號沒停用才算數。
// 使用者資料(名字、email、角色)走 db.ts 掛進來的 profiles view(= trackly.db 的 users)。
//
// 另外保留 web-gantt 版的「個人連線金鑰」(tokens.ts):別的程式(QA 電腦上的 map_system)
// 用 Authorization: Bearer pa_… 代表某個人呼叫。

import { jwtVerify } from "jose";
import { db, sqliteConn } from "./db";
import { TOKEN_PREFIX, userFromApiToken } from "./tokens";

export const SESSION_COOKIE = "trackly_session";

export interface User {
  id: string;
  email: string;
  name: string;
  /** 系統角色:admin / pm_head / pm_leader / pm / user / trial(Trackly users.role) */
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

let cachedSecret: Uint8Array | null = null;
function secretKey(): Uint8Array {
  if (cachedSecret) return cachedSecret;
  const s = process.env.SESSION_SECRET;
  if (!s && process.env.NODE_ENV === "production") {
    // 沒設就用公開的預設值等於沒有簽章:寧可整個擋下來。
    throw new Error("SESSION_SECRET 沒設定:必須跟 Trackly 用同一把隨機密鑰。");
  }
  return (cachedSecret = new TextEncoder().encode(s || "dev-insecure-secret-change-me"));
}

let warnedNoSessions = false;

/** trackly.db 的 sessions 表裡這個 session 還有效嗎(沒撤銷、沒過期、帳號沒停用)。 */
function sessionIsLive(sid: string, userId: string): boolean {
  try {
    const row = sqliteConn()
      .prepare(
        `select 1 as ok from trk.sessions s join trk.users u on u.id = s.user_id
           where s.id = ? and s.user_id = ? and s.revoked_at is null and s.expires_at > ? and u.is_active = 1`
      )
      .get(sid, userId, new Date().toISOString());
    return Boolean(row);
  } catch (e) {
    // 多半是 Trackly 還沒升級(沒有 sessions 表/is_active 欄):寧可拒絕,不放行。
    if (!warnedNoSessions) {
      warnedNoSessions = true;
      console.error("[auth] 查 trackly.db 的 sessions 失敗,所有登入都會被拒絕。要先啟動升級後的 Trackly。", e instanceof Error ? e.message : e);
    }
    return false;
  }
}

async function userFromCookie(jwt: string): Promise<User | null> {
  try {
    const { payload } = await jwtVerify(jwt, secretKey());
    if (!payload.sub || typeof payload.sid !== "string") return null;
    if (!sessionIsLive(payload.sid, payload.sub)) return null;
    // 以 trackly.db 目前的資料為準:帳號被刪掉,舊 cookie 立刻失效
    return getUserById(payload.sub);
  } catch {
    return null;
  }
}

/** token → 這個人是誰。認不得就 null,由呼叫端回 401。 */
export async function userFromToken(token: string): Promise<User | null> {
  if (!token) return null;
  if (token.startsWith(TOKEN_PREFIX)) return userFromApiToken(token);
  return userFromCookie(token);
}

function cookieValue(req: Request, name: string): string {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

function bearer(req: Request): string {
  const auth = req.headers.get("authorization") || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

/** API route 用:先看個人連線金鑰(Authorization),沒有再看 Trackly 的登入 cookie。 */
export async function apiUser(req: Request): Promise<User | null> {
  const b = bearer(req);
  if (b) return userFromToken(b);
  return userFromToken(cookieValue(req, SESSION_COOKIE));
}

/** Trackly 的網址(頂列「回 Trackly」與沒登入時的去處) */
export function tracklyUrl(host: string): string {
  const hostname = host.split(":")[0];
  return hostname === "localhost" || hostname === "127.0.0.1"
    ? `http://${hostname}:3000`
    : process.env.TRACKLY_URL || "https://trackly.orblab.app";
}
