"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/lib/paClient";
import Link from "next/link";
import { ROLES, ROLE_LABEL, type Role, type Sla } from "@/lib/pa";
import type { Member } from "@/server/pa/projects";

interface U { id: string; name: string; email: string }

const ROLE_HINT: Record<Role, string> = {
  pm: "管成員、匯入 BOM、發起 PA、填屬性",
  sourcer: "供應商、通知供應商、收齊資料、PLM、首件",
  rd: "發起 PA、屬性、RD review 與退件",
  qa: "QA review 與退件",
};

export default function Settings(props: {
  projectId: string;
  project: { name: string; code: string; archived: boolean };
  sla: Sla;
  members: Member[];
  users: U[];
  me: string;
  /** 專案 PM 或系統管理員:只有他們動得了 PM 這一格與專案本身 */
  canManage: boolean;
  /** 刪除專案只開給系統管理員 */
  isAdmin?: boolean;
}) {
  const { canManage } = props;
  const router = useRouter();
  const base = `/api/pa/projects/${props.projectId}`;
  const [members, setMembers] = useState(props.members);
  const [name, setName] = useState(props.project.name);
  const [code, setCode] = useState(props.project.code);
  const [pick, setPick] = useState("");
  const [invEmail, setInvEmail] = useState("");
  const [invName, setInvName] = useState("");
  const [invRole, setInvRole] = useState<Role>("rd");
  const [invLink, setInvLink] = useState("");

  /** 名單上沒有的人:寄邀請信。還沒有帳號 → 信裡的連結讓他設密碼,建好帳號就自動放進
   *  這個專案;已經有帳號 → 直接加進來並寄通知。 */
  const invite = () =>
    act(async () => {
      setInvLink("");
      const r = await api<{ status: string; mailed: boolean; url?: string }>("/api/invite", {
        json: { email: invEmail.trim(), name: invName.trim(), paProjectId: props.projectId, paRoles: [invRole] },
      });
      if (r.status === "added") {
        const m = await api<{ members: Member[] }>(base);
        setMembers(m.members);
      }
      if (r.url) setInvLink(r.url);
      setInvEmail("");
      setInvName("");
    }, "已送出邀請");
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});

  const candidates = useMemo(() => props.users.filter((u) => !members.some((m) => m.user_id === u.id)), [props.users, members]);

  // 頁面資料是用戶端載入的,router.refresh() 不會更新 props,封存狀態自己記著
  const [archived, setArchived] = useState(props.project.archived);

  async function act(fn: () => Promise<void>, ok: string) {
    setMsg({});
    try {
      await fn();
      setMsg({ ok });
    } catch (e) {
      setMsg({ err: e instanceof Error ? e.message : String(e) });
    }
  }

  const setRoles = (userId: string, roles: Role[]) =>
    act(async () => {
      const r = await api<{ members: Member[] }>(`${base}/members`, { method: "PUT", json: { user_id: userId, roles } });
      setMembers(r.members);
    }, "已更新成員");

  return (
    <>
      {(msg.ok || msg.err) && (
        <div className={msg.err ? "err" : "ok"} style={{ marginBottom: 12 }} role="status">
          {msg.err ?? msg.ok}
        </div>
      )}

      <div className="card section">
        <h2>成員與角色</h2>
        <div style={{ overflowX: "auto" }}>
          <table className="members">
            <thead>
              <tr>
                <th>成員</th>
                {ROLES.map((r) => (
                  <th key={r} className="ck" title={ROLE_HINT[r]}>{ROLE_LABEL[r]}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.user_id}>
                  <td>
                    <b>{m.name}</b>
                    {m.pending && <span className="chip warn" style={{ marginLeft: 8 }} title="已寄出邀請信，對方接受並設好密碼後才會成為正式成員">已邀請・待接受</span>}
                    <div className="muted" style={{ fontSize: 12 }}>{m.email}</div>
                  </td>
                  {ROLES.map((r) => (
                    <td key={r} className="ck">
                      <input
                        type="checkbox"
                        aria-label={`${m.name} ${ROLE_LABEL[r]}`}
                        checked={m.roles.includes(r)}
                        disabled={m.pending || (r === "pm" && !canManage)}
                        title={r === "pm" && !canManage ? "只有專案 PM 或系統管理員可以指派 PM" : undefined}
                        onChange={(e) => setRoles(m.user_id, e.target.checked ? [...m.roles, r] : m.roles.filter((x) => x !== r))}
                      />
                    </td>
                  ))}
                  <td>
                    {!m.pending && <button
                      className="btn btn-sm btn-ghost btn-danger"
                      disabled={m.roles.includes("pm") && !canManage}
                      title={m.roles.includes("pm") && !canManage ? "PM 要由專案 PM 或系統管理員移除" : undefined}
                      onClick={() => confirm(`把 ${m.name} 移出專案？`) && setRoles(m.user_id, [])}
                    >
                      移除
                    </button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ minWidth: 260, maxWidth: "100%" }}>
            <option value="">選擇帳號加入…</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>{u.name}（{u.email}）</option>
            ))}
          </select>
          {ROLES.filter((r) => r !== "pm" || canManage).map((r) => (
            <button key={r} className="btn btn-sm" disabled={!pick} onClick={() => { setRoles(pick, [r]); setPick(""); }}>
              加入為 {ROLE_LABEL[r]}
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <input
            type="email"
            placeholder="還沒有帳號的人：email"
            value={invEmail}
            onChange={(e) => setInvEmail(e.target.value)}
            style={{ minWidth: 220 }}
          />
          <input type="text" placeholder="名字" value={invName} onChange={(e) => setInvName(e.target.value)} style={{ width: 120 }} />
          <select value={invRole} onChange={(e) => setInvRole(e.target.value as Role)}>
            {ROLES.filter((r) => r !== "pm" || canManage).map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
          <button className="btn btn-sm" disabled={!invEmail.trim()} onClick={invite} title="寄一封信給他，點連結設定密碼就能登入，並自動加進這個專案">
            寄邀請
          </button>
        </div>
        {invLink && (
          <p className="muted" style={{ fontSize: 12.5 }}>
            伺服器沒設定寄信，請把這個連結轉給對方：
            <input readOnly value={invLink} onFocus={(e) => e.target.select()} style={{ width: "100%" }} />
          </p>
        )}
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
          {ROLES.map((r) => `${ROLE_LABEL[r]}：${ROLE_HINT[r]}`).join("　·　")}
        </p>
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
          專案成員都可以把人加進來、調整 Sourcer／RD／QA；<b>PM 只有專案 PM 或系統管理員能指派或取消</b>。
        </p>
      </div>

      {!canManage && (
        <div className="card section muted" style={{ fontSize: 13 }}>
          專案本身（改名、封存）只有專案 PM 或系統管理員能改。
        </div>
      )}

      {/* SLA 改成全公司一套、只有系統管理員能改(2026-10-08) */}
      <div className="card section muted" style={{ fontSize: 13 }}>
        SLA 天數全公司一套，由系統管理員在 <Link href="/pa/sla">PA Tracker 首頁 → SLA 設定</Link> 統一調整，
        這個專案沿用（目前：通知供應商 {props.sla.supplier_notified} 天、廠商第一次回 標準件 {props.sla.docs_std}／訂製件{" "}
        {props.sla.docs_custom} 天、RD／QA pass {props.sla.rd_pass}／{props.sla.qa_pass} 天、廠商更新資料 {props.sla.supplier_update} 天）。
      </div>

      {canManage && (
      <div className="card section">
        <h2>專案</h2>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="專案名稱" />
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="代號" aria-label="代號" />
          <button className="btn" onClick={() => act(async () => { await api(base, { method: "PATCH", json: { name, code } }); router.refresh(); }, "已儲存")}>
            儲存
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          <button
            className="btn btn-ghost"
            onClick={() => act(async () => { await api(base, { method: "PATCH", json: { archived: !archived } }); setArchived(!archived); }, archived ? "已取消封存" : "已封存（不再寄逾期信）")}
          >
            {archived ? "取消封存" : "封存專案"}
          </button>
          {props.isAdmin && (
            <button
              className="btn btn-ghost btn-danger"
              disabled={!archived}
              title={archived ? undefined : "請先封存專案再刪除"}
              onClick={() =>
                confirm(`永久刪除「${props.project.name}」？\n料號、成員、SLA、歷程會一起刪掉，無法從介面還原。`) &&
                act(async () => { await api(base, { method: "DELETE" }); router.push("/pa"); }, "已刪除")
              }
            >
              刪除專案
            </button>
          )}
        </div>
      </div>
      )}
    </>
  );
}
