import { handle, type Ctx } from "@/server/pa/http";
import { access } from "@/server/pa/projects";
import { listParts, TIMEZONE } from "@/server/pa/parts";
import { todayIn } from "@/lib/pa";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req, user, ctx: Ctx<{ id: string }>) => {
  const a = await access((await ctx.params).id, user);
  const today = todayIn(TIMEZONE);
  return { today, parts: await listParts(a.project.id, today) };
});
