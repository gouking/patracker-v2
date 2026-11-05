// 邀請信:PM 把還沒有帳號的人加進 PA 專案時寄出一封帶連結的信,
// 對方點開、設好名字和密碼,帳號就建好並直接登入。
// 從 web-gantt 的 server/invite.ts 搬來,帳號改建在這邊自己的 users 表(密碼用 scrypt)。

import { createHash, randomBytes } from "node:crypto";
import { db, newId, now } from "./db";
import { MAIL_FROM, mailer, smtpReady } from "./mail";
import { HttpError, claimPendingInvites } from "./projects";
import { MIN_PASSWORD_LENGTH, hashPassword } from "./account";
import type { User } from "./auth";

const INVITE_DAYS = 7;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const normEmail = (s: string) => s.trim().toLowerCase();
export const emailOk = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 320;

export async function userIdByEmail(email: string): Promise<string | null> {
  const r = await db.get<{ id: string }>("select id from users where lower(email) = ?", [normEmail(email)]);
  return r?.id ?? null;
}

/** 建一張邀請(同一個信箱、同一個專案還沒用掉的舊邀請作廢),回傳信裡的連結。 */
export async function createInvite(base: string, by: User, email: string, name: string, paProjectId: string, paRoles: string[]): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  const em = normEmail(email);
  const ts = now();
  await db.tx(async (t) => {
    await t.run(
      "update app_invites set used_at = ? where lower(email) = ? and used_at is null and coalesce(pa_project_id, '') = ?",
      [ts, em, paProjectId]
    );
    await t.run(
      `insert into app_invites (id, token_hash, email, name, invited_by, invited_by_name, pa_project_id, pa_roles, expires_at, created_at)
       values (?,?,?,?,?,?,?,?,?,?)`,
      [newId(), sha(token), em, name.trim(), by.id, by.name, paProjectId, paRoles.join(","), new Date(Date.now() + INVITE_DAYS * 86400000).toISOString(), ts]
    );
  });
  return `${base}/pa/invite?t=${token}`;
}

/** 寄信。沒設定 SMTP 時不丟錯,回 false,讓呼叫端把連結交給 PM 自己轉給對方。 */
export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  if (!smtpReady) return false;
  try {
    await mailer().sendMail({ from: MAIL_FROM, to, subject, text });
    return true;
  } catch (e) {
    console.error("invite: sendMail failed", e);
    return false;
  }
}

export function inviteMailText(o: { inviter: string; where: string; name: string; url: string }): { subject: string; text: string } {
  return {
    subject: `${o.inviter} 邀請你加入 ${o.where}`,
    text:
      `${o.name || "你好"}，\n\n` +
      `${o.inviter} 把你加進了「${o.where}」。\n` +
      `點下面的連結設定你的密碼，帳號就建好了，之後用這個信箱和密碼登入：\n\n` +
      `${o.url}\n\n` +
      `連結 ${INVITE_DAYS} 天內有效，只能用一次。如果你沒有預期收到這封信，直接忽略就好。\n`,
  };
}

export function addedMailText(o: { inviter: string; where: string; name: string; url: string }): { subject: string; text: string } {
  return {
    subject: `${o.inviter} 把你加進了 ${o.where}`,
    text: `${o.name || "你好"}，\n\n${o.inviter} 把你加進了「${o.where}」。用你原本的帳號登入就看得到：\n\n${o.url}\n`,
  };
}

export async function projectLabel(paProjectId: string): Promise<string> {
  const p = await db.get<{ name: string }>("select name from pa_projects where id = ?", [paProjectId]);
  return p ? `PA Tracker 專案「${p.name}」` : "PA Tracker";
}

interface InviteRow {
  id: string;
  email: string;
  name: string;
  invited_by_name: string;
  pa_project_id: string | null;
  expired: number;
  used_at: string | null;
}

async function findInvite(token: string): Promise<InviteRow> {
  if (!token) throw new HttpError(400, "連結不完整");
  const r = await db.get<InviteRow>(
    `select id, email, name, invited_by_name, pa_project_id, (expires_at < ?) as expired, used_at
       from app_invites where token_hash = ?`,
    [now(), sha(token)]
  );
  if (!r) throw new HttpError(404, "這個邀請連結無效");
  if (r.used_at) throw new HttpError(410, "這個邀請連結已經用過了。請直接登入,忘記密碼可以用「忘記密碼」重設。");
  if (r.expired) throw new HttpError(410, "這個邀請連結已過期,請請邀請你的人再寄一次。");
  return r;
}

/** 邀請頁打開時:顯示信箱、預填名字。 */
export async function describeInvite(token: string) {
  const r = await findInvite(token);
  return {
    email: r.email,
    name: r.name,
    inviter: r.invited_by_name,
    where: r.pa_project_id ? await projectLabel(r.pa_project_id) : "PA Tracker",
    hasAccount: (await userIdByEmail(r.email)) !== null,
  };
}

/** 接受邀請:建帳號、放進專案(同信箱所有還沒用掉的邀請一起兌現)。回傳新帳號,由呼叫端發 session。 */
export async function acceptInvite(token: string, name: string, password: string): Promise<{ id: string; email: string; next: string }> {
  const r = await findInvite(token);
  const nm = name.trim();
  if (!nm) throw new HttpError(400, "請填你的名字");
  if (password.length < MIN_PASSWORD_LENGTH) throw new HttpError(400, `密碼長度不足(至少 ${MIN_PASSWORD_LENGTH} 碼)`);
  if (await userIdByEmail(r.email)) throw new HttpError(409, "這個信箱已經有帳號了,請直接登入。");

  const id = newId();
  const ts = now();
  await db.run(
    `insert into users (id, email, password_hash, name, role, created_at, updated_at, is_active, email_verified_at)
     values (?,?,?,?, 'user', ?,?,1,?)`,
    [id, r.email, hashPassword(password), nm, ts, ts, ts]
  );
  // 加進專案、換掉預約的 owner、把這張(和同信箱其他)邀請標成用過
  await claimPendingInvites({ id, email: r.email, name: nm, account_role: "user", isAdmin: false });
  return { id, email: r.email, next: r.pa_project_id ? `/pa/p/${r.pa_project_id}` : "/pa" };
}
