import { body, handle, type Ctx } from "@/server/pa/http";
import { access } from "@/server/pa/projects";
import { partDetail, resolveHold, setHold } from "@/server/pa/parts";

export const dynamic = "force-dynamic";
type P = Ctx<{ id: string; partId: string }>;

/** body: { action: "set", reason, since?, owner?, note? } 開始或修改一筆卡關
 *        { action: "resolve", resolved? } 解除卡關(完成日期預設今天)
 *  回傳側欄要的完整內容(跟其他改動一樣)。 */
export const POST = handle(async (req, user, ctx: P) => {
  const { id, partId } = await ctx.params;
  const a = await access(id, user);
  const b = await body(req);
  if (b.action === "resolve") await resolveHold(a, user.id, partId, b.resolved ? String(b.resolved) : null);
  else
    await setHold(a, user.id, partId, {
      reason: String(b.reason ?? ""),
      since: b.since ? String(b.since) : null,
      owner: b.owner ? String(b.owner) : "",
      note: b.note ? String(b.note) : "",
    });
  return partDetail(a, partId);
});
