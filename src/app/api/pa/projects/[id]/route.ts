import { body, handle, type Ctx } from "@/server/pa/http";
import { access, deleteProject, getSla, listMembers, updateProject } from "@/server/pa/projects";

export const dynamic = "force-dynamic";
type P = Ctx<{ id: string }>;

export const GET = handle(async (_req, user, ctx: P) => {
  const a = await access((await ctx.params).id, user);
  return {
    me: { id: user.id, name: user.name, isAdmin: user.isAdmin },
    project: a.project,
    roles: a.roles,
    isAdmin: a.isAdmin,
    canManage: a.canManage,
    sla: await getSla(a.project.id),
    members: await listMembers(a.project.id),
  };
});

export const PATCH = handle(async (req, user, ctx: P) => {
  const a = await access((await ctx.params).id, user);
  const b = await body(req);
  // SLA 改成全公司一套,在 /api/pa/sla 由系統管理員設定
  if (b.name !== undefined || b.code !== undefined || b.archived !== undefined) {
    await updateProject(a, {
      name: b.name === undefined ? undefined : String(b.name),
      code: b.code === undefined ? undefined : String(b.code),
      archived: b.archived === undefined ? undefined : Boolean(b.archived),
    });
  }
  return { ok: true };
});

export const DELETE = handle(async (_req, user, ctx: P) => {
  await deleteProject(await access((await ctx.params).id, user));
  return { ok: true };
});
