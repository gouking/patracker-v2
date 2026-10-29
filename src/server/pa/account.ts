// 帳號的底層:密碼、一次性 token、session、速率限制、cookie。
// 從 Trackly 的 src/server/auth.ts 與 rateLimit.ts 搬過來,改成直接用 node:sqlite 連線
// (這裡全是同步呼叫)。cookie 名稱改成 pa_session,跟 Trackly 同一台主機時互不干擾。
//
// 密碼:node:crypto 的 scrypt,salt 隨機,timingSafeEqual 比對。
// Session:jose 簽的 JWT,放在 HttpOnly cookie;JWT 帶 sid,每次都回 sessions 表查
// 沒撤銷、沒過期、帳號沒停用才算數,所以登出/重設密碼/停用都立刻生效。

import { scryptSync, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { sqliteConn } from "./db";

export const SESSION_COOKIE = "pa_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 天
/** last_seen_at 最多這麼久才寫一次,避免每個 API 請求都寫資料庫。 */
const TOUCH_EVERY_MS = 5 * 60 * 1000;

const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const conn = () => sqliteConn();

let cachedSecret: Uint8Array | null = null;
function secretKey(): Uint8Array {
  if (cachedSecret) return cachedSecret;
  const s = process.env.SESSION_SECRET;
  if (!s && process.env.NODE_ENV === "production") {
    // 沒設就用公開的預設值等於沒有簽章:寧可整個擋下來。
    throw new Error("SESSION_SECRET 沒設定:正式環境必須設一把隨機密鑰(至少 32 字元)。");
  }
  return (cachedSecret = new TextEncoder().encode(s || "dev-insecure-secret-change-me"));
}

// ---------- 密碼 ----------

export const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(plain, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 匯入的帳號沒有密碼:給一個永遠驗不過的值,要先「忘記密碼」設定才能登入。 */
export const NO_PASSWORD = "none$no-password-set";

/** 查無帳號時也跑一次 scrypt,避免從回應時間猜出帳號存不存在。 */
let dummyHash = "";
export function burnPasswordTime(plain: string): void {
  if (!dummyHash) dummyHash = hashPassword("dummy-password-for-timing");
  verifyPassword(plain, dummyHash);
}

// ---------- 一次性 token(重設密碼)----------

export type TokenPurpose = "reset";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** 回傳寄給使用者的 token(`<id>.<secret>`);同用途、同使用者先前沒用掉的一律作廢。 */
export function createOneTimeToken(userId: string, purpose: TokenPurpose, ttlSeconds: number): string {
  const ts = nowIso();
  conn()
    .prepare("update one_time_tokens set used_at = ? where user_id = ? and purpose = ? and used_at is null")
    .run(ts, userId, purpose);
  const id = newId();
  const secret = randomBytes(32).toString("base64url");
  conn()
    .prepare("insert into one_time_tokens (id, user_id, purpose, token_hash, created_at, expires_at) values (?,?,?,?,?,?)")
    .run(id, userId, purpose, sha256(secret), ts, new Date(Date.now() + ttlSeconds * 1000).toISOString());
  return `${id}.${secret}`;
}

/** 驗證並「消耗」token;成功回 user id,失敗(錯誤/過期/用過)回 null。 */
export function consumeOneTimeToken(token: string, purpose: TokenPurpose): string | null {
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  const row = conn()
    .prepare(
      `select user_id, token_hash from one_time_tokens
         where id = ? and purpose = ? and used_at is null and expires_at > ?`
    )
    .get(id, purpose, nowIso()) as { user_id: string; token_hash: string } | undefined;
  if (!row) return null;
  // 先比對 secret 再消耗:猜錯不能把真的 token 燒掉。
  const a = Buffer.from(row.token_hash, "hex");
  const b = Buffer.from(sha256(secret), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // 用 update 搶佔,兩個同時進來的請求只有一個會成功。
  const claimed = conn()
    .prepare("update one_time_tokens set used_at = ? where id = ? and used_at is null returning user_id")
    .get(nowIso(), id) as { user_id: string } | undefined;
  return claimed?.user_id ?? null;
}

// ---------- Session ----------

export function clientIp(req: Request): string {
  const h = req.headers;
  return h.get("cf-connecting-ip") || (h.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

/** 建立一列 sessions,回傳 sid。 */
export function createSession(userId: string, req: Request): string {
  const id = newId();
  const ts = nowIso();
  conn()
    .prepare("insert into sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent, ip) values (?,?,?,?,?,?,?)")
    .run(
      id,
      userId,
      ts,
      new Date(Date.now() + MAX_AGE * 1000).toISOString(),
      ts,
      (req.headers.get("user-agent") || "").slice(0, 300),
      clientIp(req)
    );
  return id;
}

export function revokeSession(sid: string): void {
  conn().prepare("update sessions set revoked_at = ? where id = ? and revoked_at is null").run(nowIso(), sid);
}

/** 撤銷某人所有 session(可保留一個,例如「改密碼但別把自己踢掉」)。 */
export function revokeAllSessions(userId: string, exceptSid?: string): void {
  conn()
    .prepare("update sessions set revoked_at = ? where user_id = ? and revoked_at is null and id != ?")
    .run(nowIso(), userId, exceptSid ?? "");
}

export async function signSession(userId: string, email: string, sid: string): Promise<string> {
  return new SignJWT({ email, sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secretKey());
}

/** cookie 的 JWT → { userId, sid };簽章不對、session 失效、帳號停用都回 null。 */
export async function readSessionToken(jwt: string): Promise<{ userId: string; sid: string } | null> {
  if (!jwt) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(jwt, secretKey()));
  } catch {
    return null;
  }
  if (!payload.sub || typeof payload.sid !== "string") return null;
  const row = conn()
    .prepare(
      `select s.last_seen_at from sessions s join users u on u.id = s.user_id
         where s.id = ? and s.user_id = ? and s.revoked_at is null and s.expires_at > ? and u.is_active = 1`
    )
    .get(payload.sid, payload.sub, nowIso()) as { last_seen_at: string } | undefined;
  if (!row) return null;
  if (Date.now() - Date.parse(row.last_seen_at) > TOUCH_EVERY_MS) {
    conn().prepare("update sessions set last_seen_at = ? where id = ?").run(nowIso(), payload.sid);
  }
  return { userId: payload.sub, sid: payload.sid };
}

export function cookieValue(req: Request, name: string): string {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

// ---------- Cookie ----------
// 只掛在本站(host-only)。Secure 看這次請求是不是 https:內網直連是 http,
// 日後若經反向代理改成 https(會帶 x-forwarded-proto)也照樣能用。

export function requestIsHttps(req: Request): boolean {
  const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
  return proto ? proto === "https" : new URL(req.url).protocol === "https:";
}

function cookieLine(value: string, maxAge: number, secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${value}`, "Path=/", `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.headers.append("Set-Cookie", cookieLine(token, MAX_AGE, secure));
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.headers.append("Set-Cookie", cookieLine("", 0, secure));
}

// ---------- 速率限制 ----------
// 把「失敗/請求」寫進 auth_attempts,數時間窗內的筆數。存在資料庫:dev 會重載模組。

export interface Limit {
  kind: string;
  key: string;
  max: number;
  windowSec: number;
}

export const LIMITS = {
  /** 同一個信箱+IP 連續登入失敗 */
  loginPair: (email: string, ip: string): Limit => ({ kind: "login", key: `${email}|${ip}`, max: 5, windowSec: 15 * 60 }),
  /** 同一個 IP 對所有帳號的登入失敗(擋撒網猜密碼) */
  loginIp: (ip: string): Limit => ({ kind: "login-ip", key: ip, max: 30, windowSec: 15 * 60 }),
  /** 已登入者改密碼時輸入錯誤的舊密碼 */
  changePassword: (userId: string): Limit => ({ kind: "chgpw", key: userId, max: 5, windowSec: 15 * 60 }),
  forgotEmail: (email: string): Limit => ({ kind: "forgot", key: email, max: 3, windowSec: 3600 }),
  forgotIp: (ip: string): Limit => ({ kind: "forgot-ip", key: ip, max: 10, windowSec: 3600 }),
  signupIp: (ip: string): Limit => ({ kind: "signup-ip", key: ip, max: 10, windowSec: 3600 }),
};

const since = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();

/** 超過上限回「還要等幾秒」,沒超過回 0。 */
function retryAfter(l: Limit): number {
  const rows = conn()
    .prepare("select at from auth_attempts where kind = ? and key = ? and at > ? order by at asc")
    .all(l.kind, l.key, since(l.windowSec)) as { at: string }[];
  if (rows.length < l.max) return 0;
  const oldestCounted = rows[rows.length - l.max].at;
  return Math.max(1, Math.ceil((Date.parse(oldestCounted) + l.windowSec * 1000 - Date.now()) / 1000));
}

export function checkAll(limits: Limit[]): number {
  let wait = 0;
  for (const l of limits) wait = Math.max(wait, retryAfter(l));
  return wait;
}

export function record(l: Limit): void {
  conn().prepare("insert into auth_attempts (id, kind, key, at) values (?,?,?,?)").run(newId(), l.kind, l.key, nowIso());
  if (Math.random() < 0.02) conn().prepare("delete from auth_attempts where at < ?").run(since(24 * 3600));
}

export function clear(l: Limit): void {
  conn().prepare("delete from auth_attempts where kind = ? and key = ?").run(l.kind, l.key);
}
