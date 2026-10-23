import { body, handle } from "@/server/pa/http";
import { deleteSupplier, updateSupplier } from "@/server/pa/suppliers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const PUT = handle<Ctx>(async (req, user, ctx) => {
  const { id } = await ctx.params;
  return { supplier: await updateSupplier(user, id, await body(req)) };
});

export const DELETE = handle<Ctx>(async (_req, _user, ctx) => {
  const { id } = await ctx.params;
  await deleteSupplier(id);
});
