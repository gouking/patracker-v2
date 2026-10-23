import { handle, type Ctx } from "@/server/pa/http";
import { access } from "@/server/pa/projects";
import { exportXlsx } from "@/server/pa/bom";
import { todayIn } from "@/lib/pa";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = handle(async (_req, user, ctx: Ctx<{ id: string }>) => {
  const a = await access((await ctx.params).id, user);
  const buf = await exportXlsx(a);
  const name = `${a.project.name} PA tracker ${todayIn()}.xlsx`;
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="patracker.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
});
