import { tracklyUrl } from "@/server/pa/auth";

// 回 Trackly 首頁。查詢字串原樣帶過去(例如 ?users=1 = 打開使用者與角色視窗)。
export function GET(req: Request) {
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim();
  const search = new URL(req.url).search;
  return Response.redirect(`${tracklyUrl(host)}/${search}`, 302);
}
