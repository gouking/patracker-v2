import { handle, type Ctx } from "@/server/pa/http";
import { access } from "@/server/pa/projects";
import { deleteNote, partDetail } from "@/server/pa/parts";

export const dynamic = "force-dynamic";

export const DELETE = handle(async (_req, user, ctx: Ctx<{ id: string; noteId: string }>) => {
  const { id, noteId } = await ctx.params;
  const a = await access(id, user);
  const partId = await deleteNote(a, user.id, noteId);
  // 直接回側欄要的內容,前端不必再多打一次 GET
  return partDetail(a, partId);
});
