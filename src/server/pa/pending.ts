// 預約的 owner:被邀請、還沒建好帳號的人(pa_pending_owners)。
//
// 他們接受邀請之前沒有 user id,所以每日信與即時通知把他們當成「虛擬成員」——
// id 用 `pending:<email>`、直接寄到邀請的信箱。接受邀請那一刻 invite.ts 會把預約換成真的 owner。

import { db } from "./db";
import type { Part } from "@/lib/pa";

export type OwnerKey = "sourcer_owner" | "rd_owner";
export interface PendingOwner {
  email: string;
  name: string;
}
export type PendingByPart = Map<string, Partial<Record<OwnerKey, PendingOwner>>>;

const NAME_SQL = `(select i.name from app_invites i where lower(i.email) = lower(o.email) and i.name <> '' order by i.created_at desc limit 1)`;

/** 一個專案裡所有還在等帳號的 owner 預約 */
export async function pendingForProject(projectId: string): Promise<PendingByPart> {
  const rows = await db.all<{ part_id: string; field: OwnerKey; email: string; name: string | null }>(
    `select o.part_id, o.field, o.email, ${NAME_SQL} as name
       from pa_pending_owners o join pa_parts p on p.id = o.part_id
      where p.project_id = ?`,
    [projectId]
  );
  return toMap(rows);
}

export async function pendingForParts(partIds: string[]): Promise<PendingByPart> {
  if (!partIds.length) return new Map();
  const rows = await db.all<{ part_id: string; field: OwnerKey; email: string; name: string | null }>(
    `select o.part_id, o.field, o.email, ${NAME_SQL} as name from pa_pending_owners o where o.part_id = any(?::text[])`,
    [partIds]
  );
  return toMap(rows);
}

function toMap(rows: { part_id: string; field: OwnerKey; email: string; name: string | null }[]): PendingByPart {
  const m: PendingByPart = new Map();
  for (const r of rows) {
    const cur = m.get(r.part_id) ?? {};
    cur[r.field] = { email: r.email, name: r.name || r.email.split("@")[0] };
    m.set(r.part_id, cur);
  }
  return m;
}

export const pendingId = (email: string) => `pending:${email.toLowerCase()}`;
export const isPendingId = (id: string) => id.startsWith("pending:");

/** owner 還沒指定、但有預約的料:把 owner 換成虛擬 id,routeTo 就會挑到他 */
export function withPending<T extends Pick<Part, "id" | "sourcer_owner" | "rd_owner">>(part: T, pend: PendingByPart): T {
  const p = pend.get(part.id);
  if (!p) return part;
  const out = { ...part };
  for (const k of ["sourcer_owner", "rd_owner"] as const) {
    if (!out[k] && p[k]) out[k] = pendingId(p[k]!.email);
  }
  return out;
}

/** 這個專案該多出來的虛擬成員(Sourcer owner 預約 → sourcer、RD owner 預約 → rd) */
export function virtualMembers(pend: PendingByPart): { user_id: string; role: string }[] {
  const seen = new Set<string>();
  const out: { user_id: string; role: string }[] = [];
  for (const p of pend.values()) {
    for (const [k, role] of [["sourcer_owner", "sourcer"], ["rd_owner", "rd"]] as const) {
      const o = p[k];
      if (!o) continue;
      const key = `${pendingId(o.email)}|${role}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ user_id: pendingId(o.email), role });
    }
  }
  return out;
}

/** 虛擬成員的名字與信箱(收信用) */
export function virtualUsers(pend: PendingByPart): Map<string, { id: string; email: string; name: string }> {
  const m = new Map<string, { id: string; email: string; name: string }>();
  for (const p of pend.values()) {
    for (const o of Object.values(p)) {
      if (o) m.set(pendingId(o.email), { id: pendingId(o.email), email: o.email, name: o.name });
    }
  }
  return m;
}
