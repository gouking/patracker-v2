import { body, handle } from "@/server/pa/http";
import { canCreateProject, createProject, listProjects, rolesByProject } from "@/server/pa/projects";
import { projectStats, TIMEZONE } from "@/server/pa/parts";
import { todayIn } from "@/lib/pa";

export const dynamic = "force-dynamic";

/** ?stats=1 會一起算每個專案的進度（專案列表那幾張卡片要的數字）。
 *  數字是一次查完的：以前每個專案各跑一次 listParts()，在雲端就是每個專案好幾趟往返。 */
export const GET = handle(async (req, user) => {
  const projects = await listProjects(user);
  const me = { id: user.id, name: user.name, isAdmin: user.isAdmin };
  const canCreate = canCreateProject(user);
  if (new URL(req.url).searchParams.get("stats") !== "1") return { me, canCreate, projects };

  const ids = projects.map((p) => p.id);
  const roles = await rolesByProject(ids, user.id);
  const stats = await projectStats(ids, (id) => roles.get(id) ?? [], todayIn(TIMEZONE));
  return {
    me,
    canCreate,
    projects: projects.map((p) => ({
      ...p,
      roles: roles.get(p.id) ?? [],
      ...(stats.get(p.id) ?? { total: 0, approved: 0, started: 0, red: 0, mine: 0, phases: {}, phaseTotal: 0 }),
    })),
  };
});

export const POST = handle(async (req, user) => {
  const b = await body(req);
  return { project: await createProject(user, String(b.name ?? ""), String(b.code ?? "")) };
});
