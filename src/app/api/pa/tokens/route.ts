import { body, handle } from "@/server/pa/http";
import { createToken, listTokens } from "@/server/pa/tokens";

export const dynamic = "force-dynamic";

/** 我的連線金鑰(不含金鑰本身,只有名稱與時間) */
export const GET = handle(async (_req, user) => ({ tokens: await listTokens(user) }));

/** body: { name } —— 建一把新金鑰。原始金鑰只在這個回應裡出現一次。 */
export const POST = handle(async (req, user) => {
  const b = await body(req);
  return createToken(user, String(b.name ?? ""));
});
