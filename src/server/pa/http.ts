// PA Tracker 每支 API route 的共用外殼:登入檢查 + 把 HttpError 轉成狀態碼。

import { apiUser, type User } from "./auth";
import { HttpError } from "./projects";
import { paDbConfigured } from "./db";

export function handle<C>(fn: (req: Request, user: User, ctx: C) => Promise<unknown> | unknown) {
  return async (req: Request, ctx: C) => {
    if (!paDbConfigured) {
      return Response.json({ error: "PA Tracker 尚未設定資料庫連線(DATABASE_URL)" }, { status: 503 });
    }
    // 查帳號本身就會碰資料庫,所以它也要在 try 裡面 —— 不然資料庫連不上時
    // 這裡會直接炸掉,前端只拿得到一句沒有內容的 500。
    let user: User | null = null;
    try {
      user = await apiUser(req);
      if (!user) return Response.json({ error: "請先登入" }, { status: 401 });
      const out = await fn(req, user, ctx);
      return out instanceof Response ? out : Response.json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      console.error("[pa]", e);
      return Response.json({ error: serverError(e, user) }, { status: 500 });
    }
  };
}

/** 系統管理員看得到真正的訊息(線上出事不必翻 log);還不知道是誰的時候只回錯誤代碼,
 *  夠診斷又不會把主機、帳號這些吐給任何人。 */
export function serverError(e: unknown, user: User | null): string {
  const detail = e instanceof Error ? e.message : String(e);
  if (user?.isAdmin) return `伺服器錯誤：${detail}`;
  // 一般使用者只給一個簡短代碼(資料庫錯誤碼或錯誤種類),夠回報、不洩漏細節
  const code = (e as { code?: unknown })?.code;
  const kind = code ? String(code) : e instanceof Error ? e.name : "unknown";
  return `伺服器錯誤（${kind}）`;
}

export async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? b : {};
  } catch {
    throw new HttpError(400, "請求格式錯誤");
  }
}

export type Ctx<P> = { params: Promise<P> };
