// 帳號:signup / signin / signout / signout-all / session,以及忘記密碼、重設密碼、修改密碼。
// 從 Trackly 的同名 route 搬過來;沒有 Email 驗證(開放註冊,新帳號是最低權限,
// 要管理員在使用者頁調角色或專案 PM 把人加進專案才看得到東西)。

import fs from "node:fs";
import { sqliteConn } from "@/server/pa/db";
import {
  LIMITS,
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE,
  burnPasswordTime,
  checkAll,
  clear,
  clearSessionCookie,
  clientIp,
  consumeOneTimeToken,
  cookieValue,
  createOneTimeToken,
  createSession,
  hashPassword,
  readSessionToken,
  record,
  requestIsHttps,
  revokeAllSessions,
  revokeSession,
  setSessionCookie,
  signSession,
  verifyPassword,
} from "@/server/pa/account";
import { APP_BASE, MAIL_FROM, mailer, smtpReady } from "@/server/pa/mail";

export const dynamic = "force-dynamic";

const RESET_TTL = 3600;

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 320;
const nowIso = () => new Date().toISOString();

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  is_active: number;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function issue(req: Request, userId: string, email: string) {
  const sid = createSession(userId, req);
  const res = json({ error: null });
  setSessionCookie(res, await signSession(userId, email, sid), requestIsHttps(req));
  return res;
}

function signedOut(req: Request) {
  const res = json({ error: null });
  clearSessionCookie(res, requestIsHttps(req));
  return res;
}

const currentSession = (req: Request) => readSessionToken(cookieValue(req, SESSION_COOKIE));

export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* signout 不帶 body */
  }
  const ip = clientIp(req);
  const db = sqliteConn();

  if (action === "signout") {
    const s = await currentSession(req);
    if (s) revokeSession(s.sid);
    return signedOut(req);
  }

  if (action === "signout-all") {
    const s = await currentSession(req);
    if (s) revokeAllSessions(s.userId);
    return signedOut(req);
  }

  if (action === "signup") {
    const email = norm(body.email);
    const password = String(body.password ?? "");
    const name = String(body.name ?? "").trim();

    const signupLimit = LIMITS.signupIp(ip);
    const wait = checkAll([signupLimit]);
    if (wait) return tooMany(wait);
    record(signupLimit);

    if (!looksLikeEmail(email)) return bad("電子郵件格式不正確。");
    if (!name) return bad("請填姓名。");
    if (password.length < MIN_PASSWORD_LENGTH) return bad(`密碼長度不足(至少 ${MIN_PASSWORD_LENGTH} 碼)。`);

    const exists = db.prepare("select id from users where email = ?").get(email);
    // 從 web-gantt 匯入的帳號沒有密碼:不能用註冊「搶」走,要用忘記密碼收信設定
    if (exists) return bad("此電子郵件已有帳號。第一次登入請按「忘記密碼」收信設定密碼。");

    // 資料庫裡第一個帳號直接當 admin,否則沒人能管理。之後要加 admin 在使用者頁調整。
    const count = (db.prepare("select count(*) as n from users").get() as { n: number }).n;
    // 註冊時可自己選的角色只有這三個;PM Head、管理員等一律由管理員在使用者頁指派
    const picked = String(body.role ?? "user");
    const role = count === 0 ? "admin" : (["user", "pm", "team_head"] as const).find((r) => r === picked) ?? "user";
    const id = crypto.randomUUID();
    const ts = nowIso();
    db.prepare(
      `insert into users (id, email, password_hash, name, role, created_at, updated_at, is_active)
       values (?,?,?,?,?,?,?,1)`
    ).run(id, email, hashPassword(password), name, role, ts, ts);
    return issue(req, id, email);
  }

  if (action === "signin") {
    const email = norm(body.email);
    const password = String(body.password ?? "");

    const pair = LIMITS.loginPair(email, ip);
    const byIp = LIMITS.loginIp(ip);
    const wait = checkAll([pair, byIp]);
    if (wait) return tooMany(wait);

    const row = db
      .prepare("select id, email, password_hash, is_active from users where email = ?")
      .get(email) as UserRow | undefined;
    if (!row) burnPasswordTime(password);
    if (!row || !verifyPassword(password, row.password_hash)) {
      record(pair);
      record(byIp);
      return bad("電子郵件或密碼錯誤。第一次登入請按「忘記密碼」收信設定密碼。");
    }
    clear(pair);
    if (!row.is_active) return fail("帳號已停用,請聯絡系統管理員。", 403);
    return issue(req, row.id, row.email);
  }

  if (action === "forgot-password") {
    // 不論帳號存不存在、有沒有被限流,回應都一樣,避免被拿來探測帳號。
    const email = norm(body.email);
    const generic = json({ error: null });
    if (!looksLikeEmail(email)) return generic;

    const byEmail = LIMITS.forgotEmail(email);
    const byIp = LIMITS.forgotIp(ip);
    const wait = checkAll([byEmail, byIp]);
    record(byEmail);
    record(byIp);
    if (wait) return generic;

    const user = db.prepare("select id, is_active from users where email = ?").get(email) as
      | { id: string; is_active: number }
      | undefined;
    if (!user || !user.is_active) return generic;

    const token = createOneTimeToken(user.id, "reset", RESET_TTL);
    await mailLink(
      email,
      "PA Tracker 設定/重設密碼",
      "請點擊下列連結設定密碼(1 小時內有效)。\n若不是你本人操作,請忽略這封信,密碼不會改變:",
      `/pa/reset-password?token=${encodeURIComponent(token)}`
    );
    return generic;
  }

  if (action === "reset-password") {
    const token = String(body.token ?? "");
    const password = String(body.password ?? "");
    if (password.length < MIN_PASSWORD_LENGTH) return bad(`密碼長度不足(至少 ${MIN_PASSWORD_LENGTH} 碼)。`);
    const userId = consumeOneTimeToken(token, "reset");
    if (!userId) return bad("連結無效或已過期,請重新申請。");
    const ts = nowIso();
    db.prepare(
      "update users set password_hash = ?, updated_at = ?, email_verified_at = coalesce(email_verified_at, ?) where id = ?"
    ).run(hashPassword(password), ts, ts, userId);
    revokeAllSessions(userId); // 所有裝置都要用新密碼重新登入
    return json({ error: null });
  }

  if (action === "change-password") {
    const s = await currentSession(req);
    if (!s) return fail("請先登入。", 401);
    const oldPassword = String(body.oldPassword ?? "");
    const newPassword = String(body.newPassword ?? "");

    const limit = LIMITS.changePassword(s.userId);
    const wait = checkAll([limit]);
    if (wait) return tooMany(wait);

    const row = db.prepare("select password_hash from users where id = ?").get(s.userId) as
      | { password_hash: string }
      | undefined;
    if (!row || !verifyPassword(oldPassword, row.password_hash)) {
      record(limit);
      return bad("目前的密碼不正確。");
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) return bad(`新密碼長度不足(至少 ${MIN_PASSWORD_LENGTH} 碼)。`);
    clear(limit);
    db.prepare("update users set password_hash = ?, updated_at = ? where id = ?").run(hashPassword(newPassword), nowIso(), s.userId);
    revokeAllSessions(s.userId, s.sid); // 其他裝置登出,目前這個保留
    return json({ error: null });
  }

  return json({ error: { message: "unknown action" } }, 404);
}

export async function GET(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (action !== "session") return json({ error: { message: "unknown action" } }, 404);
  const s = await currentSession(req);
  if (!s) return json({ data: { session: null }, error: null });
  const u = sqliteConn().prepare("select id, email, name, role from users where id = ?").get(s.userId);
  return json({ data: { session: u ? { user: { ...(u as object) } } : null }, error: null });
}

async function mailLink(to: string, subject: string, intro: string, pathAndQuery: string): Promise<void> {
  // 檢查腳本用:設了 MAIL_OUTBOX_FILE(且不是正式環境)就把信寫進檔案而不是真的寄
  const outbox = process.env.NODE_ENV === "production" ? "" : process.env.MAIL_OUTBOX_FILE || "";
  if (outbox) {
    fs.appendFileSync(outbox, JSON.stringify({ to, subject, text: `${intro}\n${APP_BASE}${pathAndQuery}\n` }) + "\n");
    return;
  }
  if (!APP_BASE) {
    console.error("[auth] NEXT_PUBLIC_APP_URL 沒設定,不寄重設密碼信(信裡的連結需要站台網址)");
    return;
  }
  if (!smtpReady) {
    console.warn(`[auth] SMTP 沒設定,沒有寄出:${subject} → ${to}`);
    return;
  }
  try {
    await mailer().sendMail({ from: MAIL_FROM, to, subject, text: `${intro}\n${APP_BASE}${pathAndQuery}\n` });
  } catch (e) {
    console.error("[auth] 寄信失敗:", e instanceof Error ? e.message : e);
  }
}

function fail(message: string, status: number) {
  return json({ error: { message } }, status);
}

function bad(message: string) {
  return fail(message, 400);
}

function tooMany(waitSec: number) {
  const res = json({ error: { message: "嘗試次數過多,請稍後再試。", retry_after: waitSec } }, 429);
  res.headers.set("Retry-After", String(waitSec));
  return res;
}
