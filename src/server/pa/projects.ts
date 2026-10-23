// 專案、成員、SLA 與「這個人在這個專案能做什麼」。
// 從本機版(patracker/src/server/projects.ts)搬過來:規則一字不改,只有資料庫換成
// Postgres(所以每個函式都是 async)、表名加 pa_ 前綴、帳號改查 profiles。

import { db, newId, now } from "./db";
import { getUsersByIds, type User } from "./auth";
import { DEFAULT_SLA, ROLES, type Role, type Sla } from "@/lib/pa";

export interface Project {
  id: string;
  name: string;
  code: string;
  created_by: string;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface Access {
  project: Project;
  roles: Role[];
  isAdmin: boolean;
  /** 管成員、改 SLA、匯入 BOM */
  canManage: boolean;
}

export class HttpError extends Error {
  // 不用參數屬性(constructor(public …)):node 的 strip-only 型別移除不支援,
  // 檢查腳本會直接載入這支檔案。
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** admin / pm_leader / pm 可以開新專案,開的人自動成為該專案 PM。 */
export const canCreateProject = (u: User) => ["admin", "pm_leader", "pm"].includes(u.account_role);

export async function rolesOf(projectId: string, userId: string): Promise<Role[]> {
  const rows = await db.all<{ role: string }>(
    "select role from pa_project_members where project_id = ? and user_id = ?",
    [projectId, userId]
  );
  return rows.map((r) => r.role as Role).filter((r) => ROLES.includes(r));
}

/** 一次查「我在這幾個專案各是什麼角色」。首頁有多個專案時不要一個一個問。 */
export async function rolesByProject(projectIds: string[], userId: string): Promise<Map<string, Role[]>> {
  const out = new Map<string, Role[]>();
  if (!projectIds.length) return out;
  const rows = await db.all<{ project_id: string; role: string }>(
    "select project_id, role from pa_project_members where user_id = ? and project_id = any(?::text[])",
    [userId, projectIds]
  );
  for (const r of rows) {
    if (!ROLES.includes(r.role as Role)) continue;
    out.set(r.project_id, [...(out.get(r.project_id) ?? []), r.role as Role]);
  }
  return out;
}

/** 看不到的專案一律回 404,不透露專案存不存在。 */
export async function access(projectId: string, user: User): Promise<Access> {
  const project = await db.get<Project>("select * from pa_projects where id = ?", [projectId]);
  if (!project) throw new HttpError(404, "找不到專案");
  const roles = await rolesOf(projectId, user.id);
  // 系統管理員與 PM Head 看得到所有專案(PM Head 唯讀:沒有專案角色就改不了任何東西)
  if (!user.isAdmin && !user.canViewAll && roles.length === 0) throw new HttpError(404, "找不到專案");
  return { project, roles, isAdmin: user.isAdmin, canManage: user.isAdmin || roles.includes("pm") };
}

export function requireManage(a: Access) {
  if (!a.canManage) throw new HttpError(403, "只有專案 PM 或系統管理員可以做這件事");
}

/** 被邀請進 PA 專案的人,如果沒走邀請信的連結、而是自己註冊(或原本就有帳號),邀請還掛在那裡沒用掉,
 *  他就進不了專案。登入 PA 的時候把同信箱、沒過期的 PA 邀請兌現:加進專案、接手預約的 owner、標成已使用。 */
export async function claimPendingInvites(user: User): Promise<number> {
  if (!user.email) return 0;
  const invites = await db.all<{ id: string; pa_project_id: string; pa_roles: string }>(
    `select id::text as id, pa_project_id, pa_roles from app_invites
      where lower(email) = lower(?) and used_at is null and expires_at > now() and pa_project_id is not null`,
    [user.email]
  );
  if (!invites.length) return 0;
  await db.tx(async (t) => {
    const ts = now();
    for (const inv of invites) {
      const exists = await t.get("select 1 as x from pa_projects where id = ?", [inv.pa_project_id]);
      if (exists) {
        for (const role of inv.pa_roles.split(",").filter((r) => ROLES.includes(r as Role))) {
          await t.run(
            "insert into pa_project_members (project_id, user_id, role, created_at) values (?,?,?,?) on conflict do nothing",
            [inv.pa_project_id, user.id, role, ts]
          );
        }
      }
      await t.run("update app_invites set used_at = now() where id = ?::uuid", [inv.id]);
    }
    // 預約給這個信箱的 owner 換成他的帳號
    await t.run(
      `update pa_parts p set sourcer_owner = ?, updated_at = ?
         from pa_pending_owners o
        where o.part_id = p.id and o.field = 'sourcer_owner' and lower(o.email) = lower(?) and coalesce(p.sourcer_owner, '') = ''`,
      [user.id, ts, user.email]
    );
    await t.run(
      `update pa_parts p set rd_owner = ?, updated_at = ?
         from pa_pending_owners o
        where o.part_id = p.id and o.field = 'rd_owner' and lower(o.email) = lower(?) and coalesce(p.rd_owner, '') = ''`,
      [user.id, ts, user.email]
    );
    await t.run("delete from pa_pending_owners where lower(email) = lower(?)", [user.email]);
  });
  return invites.length;
}

export async function listProjects(user: User): Promise<Project[]> {
  try {
    await claimPendingInvites(user);
  } catch (e) {
    console.error("[pa] claim invites failed", e); // 兌現失敗不能讓首頁打不開
  }
  return listProjectsNow(user);
}

function listProjectsNow(user: User): Promise<Project[]> {
  return user.isAdmin || user.canViewAll
    ? db.all<Project>("select * from pa_projects order by archived, updated_at desc")
    : db.all<Project>(
        `select p.* from pa_projects p where exists
           (select 1 from pa_project_members m where m.project_id = p.id and m.user_id = ?)
         order by p.archived, p.updated_at desc`,
        [user.id]
      );
}

export async function createProject(user: User, name: string, code: string): Promise<Project> {
  if (!canCreateProject(user)) throw new HttpError(403, "你的帳號角色不能建立專案(需要 PM 以上)");
  const n = name.trim();
  if (!n) throw new HttpError(400, "請輸入專案名稱");
  const id = newId();
  const ts = now();
  await db.tx(async (t) => {
    await t.run("insert into pa_projects (id, name, code, created_by, created_at, updated_at) values (?,?,?,?,?,?)", [
      id, n, code.trim(), user.id, ts, ts,
    ]);
    await t.run("insert into pa_sla_settings (project_id) values (?)", [id]);
    await t.run("insert into pa_project_members (project_id, user_id, role, created_at) values (?,?,?,?)", [id, user.id, "pm", ts]);
  });
  return (await db.get<Project>("select * from pa_projects where id = ?", [id]))!;
}

export async function updateProject(a: Access, patch: { name?: string; code?: string; archived?: boolean }) {
  requireManage(a);
  const p = a.project;
  const name = patch.name !== undefined ? patch.name.trim() : p.name;
  if (!name) throw new HttpError(400, "專案名稱不能空白");
  await db.run("update pa_projects set name = ?, code = ?, archived = ?, updated_at = ? where id = ?", [
    name,
    patch.code !== undefined ? patch.code.trim() : p.code,
    patch.archived !== undefined ? (patch.archived ? 1 : 0) : p.archived,
    now(),
    p.id,
  ]);
}

/** 只有系統管理員、而且要先封存才能刪;料號、成員、SLA、歷程都靠 on delete cascade 一起刪掉。 */
export async function deleteProject(a: Access) {
  if (!a.isAdmin) throw new HttpError(403, "只有系統管理員可以刪除專案");
  if (!a.project.archived) throw new HttpError(400, "請先封存專案再刪除");
  await db.run("delete from pa_projects where id = ?", [a.project.id]);
}

/** SLA 全公司一套(pa_global_sla 唯一一列)。projectId 目前用不到,留著是因為呼叫端很多,
 *  將來要分專案也不用改它們。 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function getSla(projectId?: string): Promise<Sla> {
  const r = await db.get<Sla>(
    "select supplier_notified, docs_std, docs_custom, rd_pass, qa_pass, supplier_update, rereview from pa_global_sla where id = 1"
  );
  return r ? { ...DEFAULT_SLA, ...r } : DEFAULT_SLA;
}

/** 只有系統管理員能改,改了所有專案一起生效 */
export async function setGlobalSla(user: User, sla: Partial<Sla>): Promise<Sla> {
  if (!user.isAdmin) throw new HttpError(403, "只有系統管理員可以修改 SLA");
  const next = { ...(await getSla()) };
  for (const k of Object.keys(DEFAULT_SLA) as (keyof Sla)[]) {
    if (sla[k] === undefined) continue;
    const v = Number(sla[k]);
    if (!Number.isInteger(v) || v < 0 || v > 365) throw new HttpError(400, "SLA 天數要是 0–365 的整數");
    next[k] = v;
  }
  await db.run(
    `insert into pa_global_sla (id, supplier_notified, docs_std, docs_custom, rd_pass, qa_pass, supplier_update, rereview, updated_at, updated_by)
     values (1,?,?,?,?,?,?,?,?,?)
     on conflict (id) do update set supplier_notified = excluded.supplier_notified, docs_std = excluded.docs_std,
       docs_custom = excluded.docs_custom, rd_pass = excluded.rd_pass, qa_pass = excluded.qa_pass,
       supplier_update = excluded.supplier_update, rereview = excluded.rereview, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [next.supplier_notified, next.docs_std, next.docs_custom, next.rd_pass, next.qa_pass, next.supplier_update, next.rereview, now(), user.id]
  );
  return next;
}

export interface Member {
  user_id: string;
  name: string;
  email: string;
  roles: Role[];
  /** 已發邀請、還沒接受(還沒有帳號)。角色是邀請時指定的,接受後才會真的加進專案 */
  pending?: boolean;
}

export async function listMembers(projectId: string): Promise<Member[]> {
  const rows = await db.all<{ user_id: string; role: string }>(
    "select user_id, role from pa_project_members where project_id = ? order by created_at",
    [projectId]
  );
  const users = await getUsersByIds(rows.map((r) => r.user_id));
  const byUser = new Map<string, Member>();
  for (const r of rows) {
    const u = users.get(r.user_id);
    const m = byUser.get(r.user_id) ?? {
      user_id: r.user_id,
      name: u?.name ?? "(已刪除的帳號)",
      email: u?.email ?? "",
      roles: [],
    };
    m.roles.push(r.role as Role);
    byUser.set(r.user_id, m);
  }
  // 已發邀請、還沒接受的人也列出來(不然發了邀請卻在名單上看不到他)
  const invites = await db.all<{ id: string; email: string; name: string; pa_roles: string }>(
    `select id, email, name, pa_roles from (
       select id, email, name, pa_roles, row_number() over (partition by lower(email) order by created_at desc) as rn
         from app_invites
        where pa_project_id = ? and used_at is null and expires_at > now()
     ) where rn = 1 order by lower(email)`,
    [projectId]
  );
  const have = new Set([...byUser.values()].map((m) => m.email.toLowerCase()));
  const pendingRows: Member[] = invites
    .filter((i) => !have.has(i.email.toLowerCase()))
    .map((i) => ({
      user_id: `invite:${i.id}`,
      name: i.name || i.email.split("@")[0],
      email: i.email,
      roles: i.pa_roles.split(",").filter((r): r is Role => ROLES.includes(r as Role)),
      pending: true,
    }));
  return [...byUser.values(), ...pendingRows];
}

/** 整組覆蓋某人在專案裡的角色;空陣列 = 移出專案。
 *
 *  專案裡的任何成員都可以把人加進來、調整 Sourcer/RD/QA —— 要拉人幫忙的時候不必等 PM。
 *  唯一的例外是 PM 本身:指派或取消 PM 只有專案 PM 或系統管理員做得到,否則任何人都能
 *  把自己升成 PM,也就等於能改 SLA、匯入 BOM、把別人踢掉。 */
export async function setMemberRoles(a: Access, userId: string, roles: Role[]) {
  const clean = [...new Set(roles)].filter((r) => ROLES.includes(r));
  if (!a.canManage) {
    const before = await rolesOf(a.project.id, userId);
    if (clean.includes("pm") !== before.includes("pm")) {
      throw new HttpError(403, "只有專案 PM 或系統管理員可以指派或取消 PM");
    }
  }
  if (!(await getUsersByIds([userId])).has(userId)) throw new HttpError(400, "系統裡沒有這個帳號");
  await db.tx(async (t) => {
    await t.run("delete from pa_project_members where project_id = ? and user_id = ?", [a.project.id, userId]);
    const ts = now();
    for (const r of clean) {
      await t.run("insert into pa_project_members (project_id, user_id, role, created_at) values (?,?,?,?)", [a.project.id, userId, r, ts]);
    }
    // 他不再是這個專案的 Sourcer／RD 了 → 料上指定他當 owner 的要一併清掉,
    // 不然表格會留一堆「（已不是成員）」,逾期信也不知道該寄給誰
    for (const [field, role] of [["sourcer_owner", "sourcer"], ["rd_owner", "rd"]] as const) {
      if (clean.includes(role as Role)) continue;
      await t.run(`update pa_parts set ${field} = '', updated_at = ? where project_id = ? and ${field} = ?`, [ts, a.project.id, userId]);
    }
    // 不能把最後一個 PM 拿掉,否則除了 admin 沒人管得了這個專案
    const pms = await t.get<{ n: number }>(
      "select count(*)::int as n from pa_project_members where project_id = ? and role = 'pm'",
      [a.project.id]
    );
    if (!pms?.n) throw new HttpError(400, "專案至少要保留一位 PM");
  });
}
