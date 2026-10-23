import { body, handle, type Ctx } from "@/server/pa/http";
import { access } from "@/server/pa/projects";
import { deleteIssue, partDetail, setIssueResubmitted } from "@/server/pa/parts";

export const dynamic = "force-dynamic";

export const DELETE = handle(async (_req, user, ctx: Ctx<{ id: string; issueId: string }>) => {
  const { id, issueId } = await ctx.params;
  const a = await access(id, user);
  const partId = await deleteIssue(a, user.id, issueId);
  // 直接回側欄要的內容,前端不必再多打一次 GET
  return partDetail(a, partId);
});

/** body: { resubmitted: "YYYY-MM-DD" | null } —— 供應商送回更新資料的日期 */
export const PATCH = handle(async (req, user, ctx: Ctx<{ id: string; issueId: string }>) => {
  const { id, issueId } = await ctx.params;
  const a = await access(id, user);
  const b = await body(req);
  const partId = await setIssueResubmitted(a, user.id, issueId, b.resubmitted);
  return partDetail(a, partId);
});
