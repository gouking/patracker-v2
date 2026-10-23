import { after } from "next/server";
import { handle, type Ctx } from "@/server/pa/http";
import { sendNotices, type PaEvent } from "@/server/pa/notify";
import { HttpError, access } from "@/server/pa/projects";
import { importBom } from "@/server/pa/bom";

export const dynamic = "force-dynamic";
// 140 幾顆料的 PDF 解析加寫入,預設 10 秒不夠
export const maxDuration = 60;

// Vercel 的請求上限是 4.5MB,這裡先擋掉並講清楚
const MAX_BYTES = 4 * 1024 * 1024;

/** multipart: file（.xlsx 或 PLM 的 BOM .pdf）+ commit=0|1 + 選填 fg_model 覆寫成品機種。
 *  先 commit=0 預覽差異，確認後同一個檔案再送一次 commit=1。 */
export const POST = handle(async (req, user, ctx: Ctx<{ id: string }>) => {
  const a = await access((await ctx.params).id, user);
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "請選擇檔案");
  if (file.size > MAX_BYTES) throw new HttpError(400, "檔案太大（上限 4MB）");
  const fgModel = form?.get("fg_model");
  const events: PaEvent[] = [];
  const result = await importBom(a, user.id, await file.arrayBuffer(), form?.get("commit") === "1", {
    fg_model: typeof fgModel === "string" ? fgModel : undefined,
  }, events);
  // 匯入就自動發起 PA → 通知 Sourcer(回應送出之後才寄)
  if (events.length) after(() => sendNotices(a.project.id, user.id, events));
  return result;
});
