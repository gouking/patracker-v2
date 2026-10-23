import { body, handle, type Ctx } from "@/server/pa/http";
import { access } from "@/server/pa/projects";
import { addNote, partDetail } from "@/server/pa/parts";

export const dynamic = "force-dynamic";

/** body: { date, text } —— 記一筆進度（原本 Excel 的 remark）。專案成員都可以記。 */
export const POST = handle(async (req, user, ctx: Ctx<{ id: string; partId: string }>) => {
  const { id, partId } = await ctx.params;
  const a = await access(id, user);
  const b = await body(req);
  await addNote(a, user.id, partId, String(b.date ?? ""), String(b.text ?? ""));
  return partDetail(a, partId);
});
