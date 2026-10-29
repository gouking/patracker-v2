"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import PaPage from "@/components/pa/PaPage";
import PaTopBar from "@/components/pa/PaTopBar";
import ImportBom from "@/components/pa/ImportBom";
import { api } from "@/lib/paClient";
import { ROLE_LABEL, type Role } from "@/lib/pa";

interface Meta {
  me: { id: string; name: string; isAdmin: boolean };
  project: { id: string; name: string };
  roles: Role[];
  canManage: boolean;
}

function ImportView({ id }: { id: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<Meta>(`/api/pa/projects/${id}`)
      .then((m) => alive && setMeta(m))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [id]);

  if (error || (meta && !meta.canManage)) {
    return (
      <>
        <PaTopBar me={meta?.me} />
        <main className="page">
          <div className="card empty">{error || "只有專案 PM 或系統管理員可以匯入 BOM"}</div>
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
        crumb={meta ? <><Link href={`/pa/p/${id}`}><strong>{meta.project.name}</strong></Link> / 匯入 BOM</> : undefined}
      />
      <main className="page">
        <h1>匯入 BOM</h1>
        <p className="lede">
          三種檔案都吃：<b>.xlsx</b>（依表頭文字對欄位，原本的 PA tracker Excel 可直接匯入，連同已填的日期）、
          <b>.pdf</b>（PLM 匯出的 BOM Print Preview，含階層、用量、Ref Des、替代料與製造商）、
          <b>.xls</b>（Agile PLM 匯出的 BOM，內容同 PDF）。
          先顯示差異，確認後才寫入。
        </p>
        {!meta ? <div className="card empty">載入中…</div> : <ImportBom projectId={id} />}
        <div className="card section">
          <h2>匯入規則</h2>
          <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8 }}>
            <li>一定要有「材料料號」欄；以「主料料號 + 材料料號」判斷是不是同一顆料。</li>
            <li>成品料號、成品機種、材料品名、LIFECYCLE 等 BOM 欄位以檔案為準更新。</li>
            <li>屬性、供應商、各階段日期<b>只補空白</b>，系統裡已經填過的值不會被檔案覆蓋。</li>
            <li>RD/QA「Review iteration record」欄裡的日期會轉成退件紀錄（同一天不重複）。</li>
            <li>系統裡有、檔案裡沒有的料號會標成「已不在 BOM」（不刪除，預設隱藏），之後再出現會自動恢復。</li>
            <li>
              PDF / Agile .xls：主料料號一律記 BOM 最上層的組件（跟 Excel 的寫法一致），實際的上一階另外存成「上一階料號」；
              Mfr Name 會帶進供應商（只補空白）；Find Num 像 4-1 的替代料會標示它替代哪一顆。
            </li>
            <li>檔案上限 4MB（Vercel 的請求大小限制）。</li>
          </ul>
        </div>
      </main>
    </>
  );
}

export default function PaImportPage() {
  const params = useParams<{ id: string }>();
  return (
    <PaPage>
      <ImportView id={String(params.id)} />
    </PaPage>
  );
}
