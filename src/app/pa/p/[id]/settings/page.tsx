"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import PaPage from "@/components/pa/PaPage";
import PaTopBar from "@/components/pa/PaTopBar";
import Settings from "@/components/pa/Settings";
import { api } from "@/lib/paClient";
import { ROLE_LABEL, type Role, type Sla } from "@/lib/pa";
import type { Member } from "@/server/pa/projects";

interface Meta {
  me: { id: string; name: string; isAdmin: boolean };
  project: { id: string; name: string; code: string; archived: number };
  roles: Role[];
  canManage: boolean;
  sla: Sla;
  members: Member[];
}

interface U { id: string; name: string; email: string }

function SettingsView({ id }: { id: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [users, setUsers] = useState<U[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<Meta>(`/api/pa/projects/${id}`)
      .then(async (m) => {
        if (!alive) return;
        setMeta(m);
        const u = await api<{ users: U[] }>("/api/pa/users").catch(() => ({ users: [] }));
        if (alive) setUsers(u.users);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id]);

  if (error) {
    return (
      <>
        <PaTopBar me={meta?.me} />
        <main className="page">
          <div className="card empty">{error}</div>
          <p><Link className="btn" href={`/pa/p/${id}`}>← 回追蹤表</Link></p>
        </main>
      </>
    );
  }

  return (
    <>
      <PaTopBar
        me={meta?.me}
        roles={meta?.roles.map((r) => ROLE_LABEL[r])}
        crumb={meta ? <><Link href={`/pa/p/${id}`}><strong>{meta.project.name}</strong></Link> / 專案設定</> : undefined}
      />
      <main className="page">
        <h1>專案設定</h1>
        <p className="lede">
          成員角色決定誰能填哪一欄、誰會收到哪些逾期提醒。帳號沿用這個系統的登入，沒有帳號的人請先註冊。
          專案成員都可以把人加進來；PM 這個角色只有專案 PM 或系統管理員能指派。
        </p>
        {!meta ? (
          <div className="card empty">載入中…</div>
        ) : (
          <Settings
            projectId={id}
            project={{ name: meta.project.name, code: meta.project.code, archived: Boolean(meta.project.archived) }}
            sla={meta.sla}
            members={meta.members}
            users={users}
            me={meta.me.id}
            canManage={meta.canManage}
            isAdmin={meta.me.isAdmin}
          />
        )}
      </main>
    </>
  );
}

export default function PaSettingsPage() {
  const params = useParams<{ id: string }>();
  return (
    <PaPage>
      <SettingsView id={String(params.id)} />
    </PaPage>
  );
}
