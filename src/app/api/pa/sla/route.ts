import { body, handle } from "@/server/pa/http";
import { getSla, setGlobalSla } from "@/server/pa/projects";
import type { Sla } from "@/lib/pa";

export const dynamic = "force-dynamic";

/** 全公司的 SLA 天數(誰都可以看) */
export const GET = handle(async (_req, user) => ({ sla: await getSla(), canEdit: user.isAdmin }));

/** body: { sla } —— 只有系統管理員能改,所有專案一起生效 */
export const PUT = handle(async (req, user) => {
  const b = await body(req);
  return { sla: await setGlobalSla(user, (b.sla ?? {}) as Partial<Sla>) };
});
