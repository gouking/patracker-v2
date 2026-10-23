import { after } from "next/server";
import { body, handle, type Ctx } from "@/server/pa/http";
import { sendNotices } from "@/server/pa/notify";
import { access } from "@/server/pa/projects";
import { partDetail, partRow, updatePartField } from "@/server/pa/parts";

export const dynamic = "force-dynamic";
type P = Ctx<{ id: string; partId: string }>;

export const GET = handle(async (_req, user, ctx: P) => {
  const { id, partId } = await ctx.params;
  return partDetail(await access(id, user), partId);
});

/** body: { field, value } —— 一次改一欄，權限逐欄檢查。
 *  `?slim=1` 只回那一列（表格用）；不帶就回側欄要的完整內容。 */
export const PATCH = handle(async (req, user, ctx: P) => {
  const { id, partId } = await ctx.params;
  const a = await access(id, user);
  const b = await body(req);
  const events = await updatePartField(a, user.id, partId, String(b.field ?? ""), b.value);
  // 發起／收齊／都 pass 的即時通知:回應送出之後才寄,存檔不用等 SMTP
  if (events.length) after(() => sendNotices(a.project.id, user.id, events));
  if (new URL(req.url).searchParams.get("slim") === "1") return { part: await partRow(a, partId) };
  return partDetail(a, partId);
});
