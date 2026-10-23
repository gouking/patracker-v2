import { handle } from "@/server/pa/http";
import { listAllUsers } from "@/server/pa/auth";
import { HttpError, canCreateProject } from "@/server/pa/projects";

export const dynamic = "force-dynamic";

/** 加成員時挑人用。只給能開專案的人（PM 以上）看，一般成員拿不到全站名單。 */
export const GET = handle(async (_req, user) => {
  if (!canCreateProject(user)) throw new HttpError(403, "沒有權限");
  return { users: (await listAllUsers()).map((u) => ({ id: u.id, name: u.name, email: u.email })) };
});
