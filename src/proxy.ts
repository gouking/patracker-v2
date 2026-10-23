// 只做一件事：把目前路徑塞進 request header，讓 server component 沒登入時
// 能組出「登入後回到這一頁」的 ?next=。權限檢查不在這裡，在各頁與各 API。
import { NextResponse, type NextRequest } from "next/server";

export function proxy(req: NextRequest) {
  const h = new Headers(req.headers);
  h.set("x-pathname", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers: h } });
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
