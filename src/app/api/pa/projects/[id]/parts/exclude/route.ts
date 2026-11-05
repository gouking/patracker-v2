import { body, handle, type Ctx } from "@/server/pa/http";
import { access } from "@/server/pa/projects";
import { setExcluded, listParts, TIMEZONE } from "@/server/pa/parts";
import { todayIn } from "@/lib/pa";

export const dynamic = "force-dynamic";

/** body: { part_ids: string[], excluded: boolean } —— 批次排除／恢復追蹤（專案成員都可以）。 */
export const POST = handle(async (req, user, ctx: Ctx<{ id: string }>) => {
  const a = await access((await ctx.params).id, user);
  const b = await body(req);
  const ids = Array.isArray(b.part_ids) ? b.part_ids.map(String) : [];
  const changed = await setExcluded(a, user.id, ids, Boolean(b.excluded));
  const today = todayIn(TIMEZONE);
  return { changed, today, parts: await listParts(a.project.id, today) };
});
