import { body, handle } from "@/server/pa/http";
import { getPrefs, setPref } from "@/server/pa/prefs";

export const dynamic = "force-dynamic";

/** 我的畫面設定(追蹤表欄位、欄寬) */
export const GET = handle(async (_req, user) => ({ prefs: await getPrefs(user) }));

/** body: { key, value } —— value 是 JSON 字串 */
export const PUT = handle(async (req, user) => {
  const b = await body(req);
  await setPref(user, String(b.key ?? ""), b.value);
  return { ok: true };
});
