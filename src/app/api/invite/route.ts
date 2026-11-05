import { body, handle } from "@/server/pa/http";
import { HttpError, access, rolesOf, setMemberRoles } from "@/server/pa/projects";
import { APP_BASE } from "@/server/pa/mail";
import { ROLES, type Role } from "@/lib/pa";
import { addedMailText, createInvite, emailOk, inviteMailText, projectLabel, sendMail, userIdByEmail } from "@/server/pa/invite";

export const dynamic = "force-dynamic";

/**
 * PM 邀請一個人進 PA Tracker 專案。body: { email, name, paProjectId, paRoles: Role[] }
 *
 * 還沒有帳號 → 建邀請、寄「設定密碼」的信;已經有帳號 → 直接放進專案,寄一封「你被加進來了」的通知。
 * 沒設定 SMTP 時回傳連結,讓 PM 自己轉給對方。
 */
export const POST = handle(async (req, user) => {
  const b = await body(req);
  const email = String(b.email ?? "").trim().toLowerCase();
  const name = String(b.name ?? "").trim();
  const paProjectId = b.paProjectId ? String(b.paProjectId) : "";
  if (!emailOk(email)) throw new HttpError(400, "信箱格式不對");
  if (!paProjectId) throw new HttpError(400, "要指定一個專案");

  const a = await access(paProjectId, user);
  const paRoles = (Array.isArray(b.paRoles) ? (b.paRoles as Role[]) : []).filter((r) => ROLES.includes(r));
  if (!paRoles.length) throw new HttpError(400, "請選至少一個角色");
  if (paRoles.includes("pm") && !a.canManage) throw new HttpError(403, "只有專案 PM 或系統管理員可以指派 PM");

  const base = APP_BASE || new URL(req.url).origin;
  const where = await projectLabel(paProjectId);
  const existing = await userIdByEmail(email);

  if (existing) {
    const now = await rolesOf(paProjectId, existing);
    await setMemberRoles(a, existing, [...new Set([...now, ...paRoles])]);
    const m = addedMailText({ inviter: user.name, where, name, url: `${base}/pa/p/${paProjectId}` });
    return { status: "added", mailed: await sendMail(email, m.subject, m.text) };
  }

  const url = await createInvite(base, user, email, name, paProjectId, paRoles);
  const m = inviteMailText({ inviter: user.name, where, name, url });
  const mailed = await sendMail(email, m.subject, m.text);
  return { status: "invited", mailed, url: mailed ? undefined : url };
});
