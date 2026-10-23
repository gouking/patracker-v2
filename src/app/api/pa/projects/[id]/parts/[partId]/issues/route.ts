import { after } from "next/server";
import { body, handle, type Ctx } from "@/server/pa/http";
import { sendNotices, type PaEvent } from "@/server/pa/notify";
import { access } from "@/server/pa/projects";
import { addIssue, partDetail } from "@/server/pa/parts";

export const dynamic = "force-dynamic";

export const POST = handle(async (req, user, ctx: Ctx<{ id: string; partId: string }>) => {
  const { id, partId } = await ctx.params;
  const a = await access(id, user);
  const b = await body(req);
  const events: PaEvent[] = [];
  await addIssue(a, user.id, partId, String(b.dept ?? ""), String(b.date ?? ""), String(b.note ?? ""), events);
  // 退件剛好累積到 ESCALATE_AT 次 → 通知 PM
  if (events.length) after(() => sendNotices(a.project.id, user.id, events));
  return partDetail(a, partId);
});
