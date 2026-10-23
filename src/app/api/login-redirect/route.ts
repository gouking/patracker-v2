// 沒登入(API 回 401)時,瀏覽器被導到這裡 → 轉去 Trackly 登入,登入後回到原本那一頁。
import { tracklyUrl } from "@/server/pa/auth";

export function GET(req: Request) {
  const u = new URL(req.url);
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim();
  // 沒有反向代理(內網直接用 IP 連)時,就用這次請求本身的協定
  const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim() || u.protocol.replace(":", "");
  const next = u.searchParams.get("next") || "/pa";
  // 只允許本站內的路徑,避免變成開放式轉址
  const path = next.startsWith("/") && !next.startsWith("//") ? next : "/pa";
  const here = `${proto}://${host}${path}`;
  return Response.redirect(`${tracklyUrl(host)}/?next=${encodeURIComponent(here)}`, 302);
}
