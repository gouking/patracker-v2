"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import PaPage from "@/components/pa/PaPage";
import PaTopBar from "@/components/pa/PaTopBar";
import Tracker from "@/components/pa/Tracker";
import { api, download } from "@/lib/paClient";
import { PHASE_BY_KEY, ROLE_LABEL, type PhaseKey, type Role, type Sla } from "@/lib/pa";
import type { Member } from "@/server/pa/projects";
import type { PartRow } from "@/server/pa/parts";

interface Meta {
  me: { id: string; name: string; isAdmin: boolean };
  project: { id: string; name: string; code: string };
  roles: Role[];
  isAdmin: boolean;
  canManage: boolean;
  sla: Sla;
  members: Member[];
}

function ProjectView({ id }: { id: string }) {
  const sp = useSearchParams();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [parts, setParts] = useState<{ today: string; parts: PartRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<Meta>(`/api/pa/projects/${id}`),
      api<{ today: string; parts: PartRow[] }>(`/api/pa/projects/${id}/parts`),
    ])
      .then(([m, p]) => {
        if (!alive) return;
        setMeta(m);
        setParts(p);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id]);

  if (error) {
    return (
      <>
        <PaTopBar />
        <main className="page">
          <div className="card empty">{error}</div>
          <p><Link className="btn" href="/pa">← 回專案列表</Link></p>
        </main>
      </>
    );
  }
  if (!meta || !parts) {
    return (
      <>
        <PaTopBar />
        <main className="page"><div className="card empty">載入中…</div></main>
      </>
    );
  }

  return (
    <>
      <PaTopBar
        me={meta.me}
        roles={meta.roles.map((r) => ROLE_LABEL[r])}
        crumb={<strong>{meta.project.name}</strong>}
      >
        {/* 進度趨勢:專案成員都看得到(2026-10-15 起,原本只有 PM) */}
        <Link className="btn btn-sm" href={`/pa/p/${id}/trend`}>
          進度趨勢
        </Link>
        {meta.canManage && (
          <Link className="btn btn-sm" href={`/pa/p/${id}/import`}>
            匯入 BOM
          </Link>
        )}
        {/* 專案設定所有成員都進得去:他們可以加人、調整 Sourcer/RD/QA */}
        <Link className="btn btn-sm" href={`/pa/p/${id}/settings`}>
          專案設定
        </Link>
        <button
          className="btn btn-sm"
          onClick={() => download(`/api/pa/projects/${id}/export`, "patracker.xlsx").catch((e) => setError(String(e)))}
        >
          匯出 Excel
        </button>
      </PaTopBar>
      <Tracker
        projectId={id}
        roles={meta.roles}
        isAdmin={meta.isAdmin}
        canManage={meta.canManage}
        sla={meta.sla}
        members={meta.members}
        me={meta.me.id}
        initialToday={parts.today}
        initialParts={parts.parts}
        initialMine={sp.get("mine") === "1"}
        initialOverdue={sp.get("overdue") === "1"}
        initialPhase={PHASE_BY_KEY[sp.get("phase") as PhaseKey] ? (sp.get("phase") as PhaseKey) : null}
      />
    </>
  );
}

export default function PaProjectPage() {
  const params = useParams<{ id: string }>();
  return (
    <PaPage>
      <ProjectView id={String(params.id)} />
    </PaPage>
  );
}
