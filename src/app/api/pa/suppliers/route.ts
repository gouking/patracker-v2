import { body, handle } from "@/server/pa/http";
import { createSupplier, importFromParts, listSuppliers } from "@/server/pa/suppliers";

export const dynamic = "force-dynamic";

/** 供應商清單(所有登入的人都能看、能改) */
export const GET = handle(async () => listSuppliers());

/** body: { name, emails, contact, note } 新增;{ importFromParts: true } 把零件上出現過的供應商補進來 */
export const POST = handle(async (req, user) => {
  const b = await body(req);
  if (b.importFromParts) return { added: await importFromParts(user) };
  return { supplier: await createSupplier(user, b) };
});
