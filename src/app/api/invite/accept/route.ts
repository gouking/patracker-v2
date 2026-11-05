import { LIMITS, checkAll, clientIp, createSession, record, requestIsHttps, setSessionCookie, signSession } from "@/server/pa/account";
import { acceptInvite, describeInvite } from "@/server/pa/invite";
import { HttpError } from "@/server/pa/projects";

export const dynamic = "force-dynamic";

// 這兩支不需要登入:拿著邀請連結的人還沒有帳號。能做的事只有「看這張邀請」和
// 「用這張邀請建自己的帳號」,都要有效、沒用過、沒過期的 token。

async function wrap(fn: () => Promise<Response>) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
    console.error("[invite]", e);
    return Response.json({ error: "伺服器錯誤" }, { status: 500 });
  }
}

export const GET = (req: Request) =>
  wrap(async () => Response.json(await describeInvite(new URL(req.url).searchParams.get("t") ?? "")));

export const POST = (req: Request) =>
  wrap(async () => {
    const limit = LIMITS.signupIp(clientIp(req));
    if (checkAll([limit])) throw new HttpError(429, "嘗試次數過多,請稍後再試。");
    record(limit);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const u = await acceptInvite(String(b.t ?? ""), String(b.name ?? ""), String(b.password ?? ""));
    // 帳號建好就直接登入
    const res = Response.json({ email: u.email, next: u.next });
    setSessionCookie(res, await signSession(u.id, u.email, createSession(u.id, req)), requestIsHttps(req));
    return res;
  });
