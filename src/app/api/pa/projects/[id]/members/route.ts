import { body, handle, type Ctx } from "@/server/pa/http";
import { access, listMembers, setMemberRoles } from "@/server/pa/projects";
import type { Role } from "@/lib/pa";

export const dynamic = "force-dynamic";

/** body: { user_id, roles: Role[] }，roles 空陣列 = 移出專案 */
export const PUT = handle(async (req, user, ctx: Ctx<{ id: string }>) => {
  const a = await access((await ctx.params).id, user);
  const b = await body(req);
  await setMemberRoles(a, String(b.user_id ?? ""), Array.isArray(b.roles) ? (b.roles as Role[]) : []);
  return { members: await listMembers(a.project.id) };
});
