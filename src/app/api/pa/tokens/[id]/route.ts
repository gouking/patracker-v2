import { handle, type Ctx } from "@/server/pa/http";
import { revokeToken } from "@/server/pa/tokens";

export const dynamic = "force-dynamic";

export const DELETE = handle(async (_req, user, ctx: Ctx<{ id: string }>) => {
  await revokeToken(user, (await ctx.params).id);
  return { ok: true };
});
