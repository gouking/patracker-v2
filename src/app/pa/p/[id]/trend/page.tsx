"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import PaPage from "@/components/pa/PaPage";
import PaTopBar from "@/components/pa/PaTopBar";
import TrendView from "@/components/pa/TrendView";
import { api } from "@/lib/paClient";
import { ROLE_LABEL, type Role, type Sla } from "@/lib/pa";
import type { PartRow } from "@/server/pa/parts";

interface Meta {
  me: { id: string; name: string; isAdmin: boolean };
  project: { id: string; name: string };
  roles: Role[];
  canManage: boolean;
  sla: Sla;
}

function TrendPage({ id }: { id: string }) {
  const [data, setData] = useState<{ meta: Meta; today: string; parts: PartRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<Meta>(`/api/pa/projects/${id}`),
      api<{ today: string; parts: PartRow[] }>(`/api/pa/projects/${id}/parts`),
    ])
      .then(([meta, p]) => alive && setData({ meta, today: p.today, parts: p.parts }))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <>
      <PaTopBar
        me={data?.meta.me}
        roles={data?.meta.roles.map((r) => ROLE_LABEL[r])}
        crumb={
          <>
            <Link href={`/pa/p/${id}`}>{data?.meta.project.name ?? "專案"}</Link> / <strong>進度趨勢</strong>
          </>
        }
      >
        <Link className="btn btn-sm" href={`/pa/p/${id}`}>← 回追蹤表</Link>
      </PaTopBar>
      <main className="page">
        {error ? (
          <div className="card empty">{error}</div>
        ) : !data ? (
          <div className="card empty">載入中…</div>
        ) : (
          <TrendView parts={data.parts} sla={data.meta.sla} today={data.today} />
        )}
      </main>
    </>
  );
}

export default function PaTrendRoute() {
  const params = useParams<{ id: string }>();
  return (
    <PaPage>
      <TrendPage id={String(params.id)} />
    </PaPage>
  );
}
