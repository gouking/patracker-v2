// 每日逾期信。兩種呼叫方式：
//   * Vercel Cron（Authorization: Bearer $CRON_SECRET）→ 真的寄出當天的份
//   * admin 帶自己的 supabase token → 預覽今天會寄給誰；POST 則是手動補寄
// 已經寄過的人不會重寄（pa_digest_log）。

import { apiUser } from "@/server/pa/auth";
import { paDbConfigured } from "@/server/pa/db";
import { buildDigests, renderDigest, sendDigests, smtpReady } from "@/server/pa/digest";
import { TIMEZONE } from "@/server/pa/parts";
import { todayIn } from "@/lib/pa";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET;

function bearer(req: Request): string {
  const auth = req.headers.get("authorization") || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

export async function GET(req: Request) {
  if (!paDbConfigured) return Response.json({ error: "pa_db_not_configured" }, { status: 503 });
  const token = bearer(req);

  // 排程來的：直接寄
  if (CRON_SECRET && token === CRON_SECRET) {
    if (!smtpReady) return Response.json({ sent: 0, reason: "smtp_not_configured" });
    return Response.json(await sendDigests());
  }

  // 人來的：只有 admin 看得到今天會寄什麼
  const user = await apiUser(req);
  if (!user) return Response.json({ error: "請先登入" }, { status: 401 });
  if (!user.isAdmin) return Response.json({ error: "只有系統管理員可以看" }, { status: 403 });
  const today = todayIn(TIMEZONE);
  const digests = await buildDigests(today);
  const who = new URL(req.url).searchParams.get("html");
  if (who) {
    const d = digests.find((x) => x.user_id === who);
    if (!d) return Response.json({ error: "這個人今天沒有逾期項目" }, { status: 404 });
    return new Response(renderDigest(d, today).html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  return Response.json({
    today,
    smtpReady,
    digests: digests.map((d) => ({ user_id: d.user_id, name: d.name, email: d.email, total: d.total })),
  });
}

/** admin 手動補寄今天的份（已寄過的人不會重寄）。 */
export async function POST(req: Request) {
  if (!paDbConfigured) return Response.json({ error: "pa_db_not_configured" }, { status: 503 });
  const user = await apiUser(req);
  if (!user) return Response.json({ error: "請先登入" }, { status: 401 });
  if (!user.isAdmin) return Response.json({ error: "只有系統管理員可以寄" }, { status: 403 });
  if (!smtpReady) return Response.json({ error: "SMTP 尚未設定" }, { status: 400 });
  return Response.json(await sendDigests());
}
