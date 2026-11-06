// 使用者管理(只有系統管理員):列出所有帳號、改角色、停用/啟用。
//
// GET                         → 全部帳號
// PATCH { id, role?, is_active? }

import { handle, body } from "@/server/pa/http";
import { sqliteConn } from "@/server/pa/db";
import { revokeAllSessions } from "@/server/pa/account";
import { HttpError } from "@/server/pa/projects";
import type { User } from "@/server/pa/auth";

export const dynamic = "force-dynamic";

const ROLES = ["admin", "team_head", "pm_head", "pm_leader", "pm", "user", "trial"] as const;

function requireAdmin(u: User) {
  if (!u.isAdmin || u.viaToken) throw new HttpError(403, "只有系統管理員可以管理使用者");
}

export const GET = handle(async (_req, user) => {
  requireAdmin(user);
  const rows = sqliteConn()
    .prepare(
      `select u.id, u.email, u.name, u.role, u.is_active, u.created_at,
              u.password_hash not like 'scrypt$%' as no_password,
              (select max(s.created_at) from sessions s where s.user_id = u.id) as last_login
         from users u order by u.is_active desc, u.name, u.email`
    )
    .all();
  return { users: rows.map((r) => ({ ...(r as object) })), roles: ROLES };
});

export const PATCH = handle(async (req, user) => {
  requireAdmin(user);
  const b = await body(req);
  const id = String(b.id ?? "");
  const db = sqliteConn();
  const target = db.prepare("select id, role, is_active from users where id = ?").get(id) as
    | { id: string; role: string; is_active: number }
    | undefined;
  if (!target) throw new HttpError(404, "找不到這個帳號");

  const role = b.role === undefined ? target.role : String(b.role);
  if (!(ROLES as readonly string[]).includes(role)) throw new HttpError(400, "沒有這個角色");
  const active = b.is_active === undefined ? target.is_active : b.is_active ? 1 : 0;

  // 不能把自己降級或停用:避免整個系統沒有管理員
  if (id === user.id && (role !== "admin" || !active)) throw new HttpError(400, "不能把自己降級或停用");
  if (target.role === "admin" && (role !== "admin" || !active)) {
    const admins = (db.prepare("select count(*) as n from users where role = 'admin' and is_active = 1").get() as { n: number }).n;
    if (admins <= 1) throw new HttpError(400, "至少要留一位啟用中的系統管理員");
  }

  db.prepare("update users set role = ?, is_active = ?, updated_at = ? where id = ?").run(role, active, new Date().toISOString(), id);
  if (!active) revokeAllSessions(id); // 停用立刻生效
  return { ok: true };
});

/** 刪除帳號(不可復原):連同專案成員資格、連線金鑰、偏好設定一起清掉。歷史紀錄保留。 */
export const DELETE = handle(async (req, user) => {
  requireAdmin(user);
  const b = await body(req);
  const id = String(b.id ?? "");
  const db = sqliteConn();
  const target = db.prepare("select id, role, is_active from users where id = ?").get(id) as
    | { id: string; role: string; is_active: number }
    | undefined;
  if (!target) throw new HttpError(404, "找不到這個帳號");
  if (id === user.id) throw new HttpError(400, "不能刪除自己");
  if (target.role === "admin" && target.is_active) {
    const admins = (db.prepare("select count(*) as n from users where role = 'admin' and is_active = 1").get() as { n: number }).n;
    if (admins <= 1) throw new HttpError(400, "至少要留一位啟用中的系統管理員");
  }
  revokeAllSessions(id);
  db.exec("BEGIN");
  try {
    for (const t of ["pa_project_members","pa_api_tokens", "pa_user_prefs", "pa_digest_log"])
      db.prepare(`delete from ${t} where user_id = ?`).run(id);
    db.prepare("delete from users where id = ?").run(id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { ok: true };
});
