// 首頁「今日概況」上那一區 PA 摘要的數字。唯讀、只回登入者自己的。
//
// Trackly 的首頁從另一個 port(或另一個子網域)打過來,帶的是 Trackly 的登入 cookie,
// 所以要 CORS:只放行同一台主機(內網 IP 直連)與 *.orblab.app 的 https。

import { apiUser } from "@/server/pa/auth";
import { paDbConfigured } from "@/server/pa/db";
import { listProjects, rolesByProject } from "@/server/pa/projects";
import { TIMEZONE, projectStats } from "@/server/pa/parts";
import { todayIn, type Role } from "@/lib/pa";

export const dynamic = "force-dynamic";

function allowedOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  try {
    const o = new URL(origin);
    const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim().split(":")[0].toLowerCase();
    const h = o.hostname.toLowerCase();
    if (o.protocol === "https:" && (h === "orblab.app" || h.endsWith(".orblab.app"))) return o.origin;
    if (o.protocol === "http:" && h === host) return o.origin;
  } catch {
    /* 不是合法網址 */
  }
  return null;
}

export async function GET(req: Request) {
  const res = await body(req);
  const origin = allowedOrigin(req);
  if (origin) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Access-Control-Allow-Credentials", "true");
    res.headers.set("Vary", "Origin");
  }
  return res;
}

async function body(req: Request): Promise<Response> {
  // 沒設定資料庫、沒登入都不是錯誤：首頁那一區就只是不顯示
  if (!paDbConfigured) return Response.json({ signedIn: false, projects: [] });
  try {
    return await summary(req);
  } catch (e) {
    // 這一區壞掉不可以拖垮甘特圖的首頁
    console.error("[pa summary]", e);
    return Response.json({ signedIn: false, projects: [] });
  }
}

async function summary(req: Request) {
  const user = await apiUser(req);
  if (!user) return Response.json({ signedIn: false, projects: [] });

  const today = todayIn(TIMEZONE);
  const projects = (await listProjects(user)).filter((p) => !p.archived);
  const ids = projects.map((p) => p.id);
  const roles = await rolesByProject(ids, user.id);
  // admin 沒掛角色時看全部，有掛角色就只算自己那幾步
  const mineRoles = (id: string) => {
    const r = roles.get(id) ?? [];
    return r.length ? r : user.isAdmin ? (["pm", "sourcer", "rd", "qa"] as Role[]) : [];
  };
  const stats = await projectStats(ids, mineRoles, today);

  const out = projects.map((p) => {
    const s = stats.get(p.id) ?? { total: 0, approved: 0, red: 0, mine: 0 };
    return {
      id: p.id,
      name: p.name,
      roles: roles.get(p.id) ?? [],
      total: s.total,
      approved: s.approved,
      mine: s.mine,
      overdue: s.red,
    };
  });

  return Response.json({ signedIn: true, today, projects: out });
}
