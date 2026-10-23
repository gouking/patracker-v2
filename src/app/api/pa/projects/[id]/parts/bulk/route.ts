import { after } from "next/server";
import { body, handle, type Ctx } from "@/server/pa/http";
import { sendNotices, type PaEvent } from "@/server/pa/notify";
import { access } from "@/server/pa/projects";
import { updatePartsField, listParts, TIMEZONE } from "@/server/pa/parts";
import { todayIn } from "@/lib/pa";

export const dynamic = "force-dynamic";

/** body: { part_ids: string[], field, value } —— 批次填同一欄（屬性、日期…），權限逐欄檢查。 */
export const POST = handle(async (req, user, ctx: Ctx<{ id: string }>) => {
  const a = await access((await ctx.params).id, user);
  const b = await body(req);
  const ids = Array.isArray(b.part_ids) ? b.part_ids.map(String) : [];
  const events: PaEvent[] = [];
  const changed = await updatePartsField(a, user.id, ids, String(b.field ?? ""), b.value, events);
  if (events.length) after(() => sendNotices(a.project.id, user.id, events));
  const today = todayIn(TIMEZONE);
  return { changed, today, parts: await listParts(a.project.id, today) };
});
