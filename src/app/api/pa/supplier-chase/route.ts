// 每日催供應商信。兩種呼叫方式:
//   * Vercel Cron(Authorization: Bearer $CRON_SECRET)→ 真的寄給供應商清單裡有 Email 的供應商
//   * admin 帶自己的 supabase token → GET 預覽今天會寄給誰;POST {to, supplier?} 把催信「測試寄」到指定信箱
//     (不寄給供應商、不寫紀錄)
// 同一天同一家供應商只寄一次(pa_supplier_chase_log)。

import { apiUser } from "@/server/pa/auth";
import { paDbConfigured } from "@/server/pa/db";
import { smtpReady } from "@/server/pa/mail";
import { TIMEZONE } from "@/server/pa/parts";
import { buildSupplierChase, sendSupplierChase, sendSupplierChaseTest } from "@/server/pa/supplierChase";
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
  if (CRON_SECRET && bearer(req) === CRON_SECRET) {
    if (!smtpReady) return Response.json({ sent: 0, reason: "smtp_not_configured" });
    return Response.json(await sendSupplierChase());
  }
  const user = await apiUser(req);
  if (!user) return Response.json({ error: "請先登入" }, { status: 401 });
  if (!user.isAdmin) return Response.json({ error: "只有系統管理員可以看" }, { status: 403 });
  const today = todayIn(TIMEZONE);
  const { chases, noEmail } = await buildSupplierChase(today);
  return Response.json({
    today,
    smtpReady,
    willSend: chases.map((c) => ({ supplier: c.supplier, to: c.emails, items: c.items.length })),
    noEmail,
  });
}

/** admin 測試寄:body { to, supplier? } */
export async function POST(req: Request) {
  if (!paDbConfigured) return Response.json({ error: "pa_db_not_configured" }, { status: 503 });
  const user = await apiUser(req);
  if (!user) return Response.json({ error: "請先登入" }, { status: 401 });
  if (!user.isAdmin) return Response.json({ error: "只有系統管理員可以寄" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { to?: string; supplier?: string };
  const to = String(b.to ?? "").trim();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) return Response.json({ error: "請給一個測試收件信箱" }, { status: 400 });
  return Response.json(await sendSupplierChaseTest(to, b.supplier ? String(b.supplier) : undefined));
}
