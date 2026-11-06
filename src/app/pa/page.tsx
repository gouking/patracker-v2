"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import PaPage from "@/components/pa/PaPage";
import PaTopBar from "@/components/pa/PaTopBar";
import NewProject from "@/components/pa/NewProject";
import PhaseBoard from "@/components/pa/PhaseBoard";
import { api } from "@/lib/paClient";
import { ROLE_LABEL, type PhaseKey, type Role } from "@/lib/pa";

interface ProjectCard {
  id: string;
  name: string;
  code: string;
  archived: number;
  roles: Role[];
  total: number;
  approved: number;
  started: number;
  red: number;
  phases: Partial<Record<PhaseKey, number>>;
  phaseTotal: number;
  reworkQa?: Record<number, number>;
}

interface Payload {
  me: { id: string; name: string; isAdmin: boolean };
  canCreate: boolean;
  projects: ProjectCard[];
}

function Projects() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<Payload>("/api/pa/projects?stats=1")
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <PaTopBar me={data?.me}>
        {/* 給 QA 電腦上的 map_system 這類程式用 */}
        <Link className="btn btn-sm btn-ghost" href="/pa/suppliers" title="供應商與 Email（催供應商發信用，所有人都能維護）">
          供應商清單
        </Link>
        {data?.me.isAdmin && (
          <a className="btn btn-sm btn-ghost" href="/pa/users" title="設定每個人的系統角色，例如 PM Head（看得到所有專案）">
            使用者與角色
          </a>
        )}
        <Link className="btn btn-sm btn-ghost" href="/pa/sla" title="全公司的 SLA 天數（系統管理員可修改）">
          SLA 設定
        </Link>
        {data?.me.isAdmin && (
          <Link className="btn btn-sm btn-ghost" href="/pa/connect" title="給 map_system 等程式用的個人連線金鑰（僅管理者）">
            連線金鑰
          </Link>
        )}
      </PaTopBar>
      <main className="page">
        <h1>零件承認追蹤</h1>
        <p className="lede">每顆料從 PM/RD 發起、Sourcer 通知供應商、收齊資料，到 RD 與 QA review pass 的進度與逾期狀況。</p>

        {error && <div className="err">{error}</div>}
        {/* 骨架:第一次進來要跟資料庫建連線(雲端上大約半秒),與其讓人盯著「載入中…」,
            不如先把版面畫出來 */}
        {!data && !error && (
          <div className="projgrid" aria-busy="true">
            {[0, 1].map((i) => (
              <div key={i} className="card projcard skeleton">
                <div>
                  <h2>載入中…</h2>
                  <div className="code">&nbsp;</div>
                </div>
                <div className="progress" />
                <div className="projstats">
                  <span>料號 <b>—</b></span>
                  <span>RD+QA pass <b>—</b></span>
                  <span>進行中 <b>—</b></span>
                  <span>逾期 <b>—</b></span>
                </div>
              </div>
            ))}
          </div>
        )}

        {data?.canCreate && <NewProject />}

        {data && data.projects.length === 0 && (
          <div className="card empty">
            {data.canCreate
              ? "還沒有專案。在上面輸入名稱建立第一個，接著匯入 BOM。"
              : "你還沒被加入任何專案。請專案 PM 在「專案設定」把你加進去。"}
          </div>
        )}

        {data && data.projects.length > 0 && (
          <div className="projgrid">
            {data.projects.map((p) => {
              const pct = (n: number) => (p.total ? `${(n / p.total) * 100}%` : "0");
              const roles = (
                <div className="row">
                  {p.roles.length ? (
                    p.roles.map((r) => (
                      <span key={r} className="chip info">
                        {ROLE_LABEL[r]}
                      </span>
                    ))
                  ) : (
                    <span className="chip">Admin 檢視</span>
                  )}
                </div>
              );
              const stats = (
                <div className="projstats">
                  <span>料號 <b>{p.total}</b></span>
                  <span>RD+QA pass <b>{p.approved}</b></span>
                  <span>進行中 <b>{p.started}</b></span>
                  <span className={p.red ? "bad" : ""}>逾期 <b>{p.red}</b></span>
                </div>
              );
              // 有料號的專案:一張全寬卡片,階段表直接放在裡面(表格每一列都是連結,所以外層不能再包一個 Link)
              if (p.phaseTotal > 0)
                return (
                  <section key={p.id} className="card projcard projwide" style={p.archived ? { opacity: 0.6 } : undefined}>
                    <div className="pw-head">
                      <Link href={`/pa/p/${p.id}`} className="pw-title">
                        <h2>{p.name}</h2>
                        <span className="code">
                          {p.code}
                          {p.archived ? "（已封存）" : ""}
                        </span>
                      </Link>
                      {stats}
                      {roles}
                      <span className="spacer" />
                      <Link href={`/pa/p/${p.id}`} className="btn btn-sm">
                        打開追蹤表 →
                      </Link>
                    </div>
                    <PhaseBoard projectId={p.id} counts={p.phases} total={p.phaseTotal} reworkQa={p.reworkQa} />
                  </section>
                );
              return (
                <Link key={p.id} href={`/pa/p/${p.id}`} className="card projcard" style={p.archived ? { opacity: 0.6 } : undefined}>
                  <div>
                    <h2>{p.name}</h2>
                    <div className="code">
                      {p.code || " "}
                      {p.archived ? "（已封存）" : ""}
                    </div>
                  </div>
                  <div className="progress" aria-label={`${p.approved} / ${p.total} 已承認`}>
                    <i className="p-done" style={{ width: pct(p.approved) }} />
                    <i className="p-going" style={{ width: pct(p.started) }} />
                  </div>
                  {stats}
                  {roles}
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}

export default function PaHome() {
  return (
    <PaPage>
      <Projects />
    </PaPage>
  );
}
