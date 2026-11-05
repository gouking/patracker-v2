"use client";

import Link from "next/link";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, shortDate } from "@/lib/paClient";
import {
  ESCALATE_AT,
  FIELDS,
  HOLD_REASONS,
  holdHint,
  OWNER_ROLE,
  PART_TYPES,
  PHASES,
  PHASE_BY_KEY,
  REVIEW_START,
  STAGES,
  daysBetween,
  stageStart,
  STAGE_OF_START,
  canEditField,
  evalPart,
  slaColumn,
  stageDays,
  type Part,
  type PhaseKey,
  type Role,
  type Sla,
  type StageKey,
} from "@/lib/pa";
import {
  HIDDEN_DEFAULT,
  clampColW,
  readColWidths,
  readHiddenCols,
  resetColWidths,
  serverColWidths,
  serverHiddenCols,
  subscribeHiddenCols,
  syncColPrefs,
  writeColWidth,
  writeHiddenCols,
} from "@/lib/paCols";
import type { PartDetail, PartRow } from "@/server/pa/parts";
import { localFilters, saveFilters, serverFilters, type SavedFilters } from "@/lib/paFilters";
import PartDrawer from "./PartDrawer";

type ColKey = keyof Part | "phase" | "rd_issues" | "qa_issues" | "recent_notes" | "supplier_update_qa" | "supplier_update_rd";

interface Col {
  key: ColKey;
  label: string;
  who?: string;
  /** 固定寬度（px）。table-layout: fixed 要靠它——欄寬讓瀏覽器自己算的話，
   *  2000 多 px 寬的表格每次捲動／hover 都要重算整張版面，會很卡。 */
  w: number;
  sticky?: "c-pn" | "c-desc";
}

const COLS: Col[] = [
  { w: 132, key: "part_pn", label: "材料料號", sticky: "c-pn" },
  { w: 250, key: "part_desc", label: "材料品名", sticky: "c-desc" },
  // 原本還有一欄「Status（自動）」(最後發生的事,原 Excel 的英文下拉);2026-10-08 使用者決定只留階段
  { w: 112, key: "phase", label: "階段（自動）" },
  { w: 76, key: "part_type", label: "屬性", who: "PM/RD" },
  { w: 150, key: "supplier", label: "供應商", who: "Sourcer" },
  { w: 118, key: "sourcer_owner", label: "Sourcer owner", who: "Sourcer" },
  { w: 112, key: "rd_owner", label: "RD owner", who: "PM/RD" },
  // 原本 Excel 的 remark:一列多行、不截斷,全部歷程都列出來(新到舊),點一下就能再記一筆
  { w: 330, key: "recent_notes", label: "進度（remark）", who: "大家" },
  { w: 104, key: "pa_start", label: "發起 PA", who: "PM/RD" },
  { w: 104, key: "supplier_notified", label: "通知供應商", who: "Sourcer" },
  { w: 118, key: "docs_received", label: "收齊資料通知 QA", who: "Sourcer" },
  { w: 104, key: "sample_received", label: "承認樣品", who: "Sourcer（採購）" },
  // 流程:QA 先審、QA pass 之後才換 RD 審(2026-10-13),欄位照這個順序排
  { w: 104, key: "qa_review_start", label: "QA 開始 review", who: "QA" },
  { w: 96, key: "qa_issues", label: "QA 退件", who: "QA" },
  // 退件之後等供應商送回更新資料:有自己的 SLA(專案設定),逾期標紅。點一下開側欄填日期
  { w: 124, key: "supplier_update_qa", label: "供應商更新資料（QA）", who: "QA" },
  { w: 104, key: "qa_pass", label: "QA review pass", who: "QA" },
  { w: 104, key: "rd_review_start", label: "RD 開始 review", who: "RD" },
  // 退件夾在「開始 review」與「pass」中間,照流程順序:開始審 → 退件給供應商 → pass
  { w: 96, key: "rd_issues", label: "RD 退件", who: "RD" },
  { w: 124, key: "supplier_update_rd", label: "供應商更新資料（RD）", who: "RD" },
  { w: 104, key: "rd_pass", label: "RD review pass", who: "RD" },
  { w: 104, key: "drawing_release", label: "圖面 Release", who: "RD、Sourcer" },
  // 流程圖最後一段:RD、QA 都 pass 之後 Sourcer 上傳 PLM 送簽 → Released 才算真的做完
  { w: 104, key: "plm_upload", label: "上傳 PLM 送簽", who: "Sourcer" },
  { w: 104, key: "plm_released", label: "PLM Released", who: "Sourcer" },
  { w: 176, key: "hold_reason", label: "卡關原因", who: "PM/RD" },
  // BOM 欄位只能靠匯入改，平常不太看，放最後（預設都收起來，要看再從「欄位」勾出來）
  { w: 170, key: "lifecycle", label: "LIFECYCLE" },
  { w: 130, key: "fg_model", label: "成品機種" },
  { w: 120, key: "main_pn", label: "主料料號" },
  { w: 120, key: "fg_pn", label: "成品料號" },
  { w: 160, key: "fg_desc", label: "成品機種材料品名" },
  { w: 80, key: "bom_level", label: "BOM 階層" },
  { w: 120, key: "parent_pn", label: "上一階料號" },
  { w: 80, key: "find_num", label: "Find Num" },
  { w: 130, key: "alt_of_pn", label: "替代料（替代誰）" },
  { w: 64, key: "qty", label: "用量" },
  { w: 240, key: "ref_des", label: "Ref Des（位置）" },
];

const STAGE_KEYS = new Set<string>(STAGES.map((s) => s.key));
const DATE_COLS = new Set<string>(FIELDS.filter((f) => f.kind === "date").map((f) => f.key));
const PHASE_ORDER = new Map(PHASES.map((p, i) => [p.key, i]));
/** 這兩欄是對照基準,收起來就不知道在看哪一列了 */
const ALWAYS: string[] = ["part_pn", "part_desc"];

export default function Tracker(props: {
  projectId: string;
  roles: Role[];
  isAdmin: boolean;
  canManage: boolean;
  sla: Sla;
  /** 指定 Sourcer owner 時可以挑的人(這個專案的成員) */
  members: { user_id: string; name: string; roles: Role[] }[];
  me: string;
  initialToday: string;
  initialParts: PartRow[];
  initialMine: boolean;
  initialOverdue: boolean;
  /** 從專案列表的階段 Dashboard 點進來時帶的 ?phase= */
  initialPhase: PhaseKey | null;
  /** 從階段 Dashboard「被 QA 退件 N 次」點進來時帶的 ?rej=N:只看 QA 退件剛好 N 次的料 */
  initialRej: number | null;
}) {
  const { projectId, roles, isAdmin, sla, me } = props;
  const [parts, setParts] = useState(props.initialParts);
  const [today, setToday] = useState(props.initialToday);
  const [q, setQ] = useState("");
  const [model, setModel] = useState("");
  const [lifecycle, setLifecycle] = useState("");
  const [ptype, setPtype] = useState("");
  const [mine, setMine] = useState(props.initialMine);
  const [owned, setOwned] = useState(false);
  /** 依負責人篩選(Sourcer owner 或 RD owner):帳號 id、pending:信箱,或 "none" = 沒有指定任何負責人 */
  const [ownerFilter, setOwnerFilter] = useState("");
  const [overdue, setOverdue] = useState(props.initialOverdue);
  const [stageFilter, setStageFilter] = useState<StageKey | "approved" | "missingType" | "escalated" | "supplier_update" | null>(null);
  const [phaseFilter, setPhaseFilter] = useState<PhaseKey | null>(props.initialPhase);
  const [rejFilter, setRejFilter] = useState<number | null>(props.initialRej);
  const [showRemoved, setShowRemoved] = useState(false);
  const [hideAlts, setHideAlts] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  // 顯示哪幾欄（存在這台瀏覽器）。第一次進來用預設,剩下的寬度放得進一個畫面。
  const hidden = useSyncExternalStore(subscribeHiddenCols, readHiddenCols, serverHiddenCols);
  const colW = useSyncExternalStore(subscribeHiddenCols, readColWidths, serverColWidths);
  const [colMenu, setColMenu] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkField, setBulkField] = useState("");
  const [bulkDate, setBulkDate] = useState("");
  const [sort, setSort] = useState<{ key: ColKey; dir: 1 | -1 } | null>(null);
  const [editing, setEditing] = useState<{ id: string; key: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await api<{ today: string; parts: PartRow[] }>(`/api/pa/projects/${projectId}/parts`);
      // 沒變的列沿用原本的物件：memo 才擋得住，不然每分鐘（以及每次切回視窗）
      // 整張表 140 幾列會全部重畫
      setParts((prev) => {
        const old = new Map(prev.map((p) => [p.id, p]));
        let changed = prev.length !== r.parts.length;
        const next = r.parts.map((p) => {
          const o = old.get(p.id);
          if (o && JSON.stringify(o) === JSON.stringify(p)) return o;
          changed = true;
          return p;
        });
        return changed ? next : prev;
      });
      setToday(r.today);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  // 多人同時在填：回到分頁時、以及每分鐘，拉一次最新狀態（編輯中不拉，免得打斷）
  useEffect(() => {
    const onFocus = () => {
      if (!editing) reload();
    };
    window.addEventListener("focus", onFocus);
    const t = setInterval(onFocus, 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(t);
    };
  }, [reload, editing]);

  // Sourcer owner／RD owner 的下拉選單(只列那個角色的成員)與顯示名稱。參考要穩定,Row 才 memo 得住。
  const owners = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(OWNER_ROLE).map(([key, role]) => [
          key,
          props.members.filter((m) => m.roles.includes(role)).map((m) => ({ id: m.user_id, name: m.name })),
        ])
      ) as Record<string, { id: string; name: string }[]>,
    [props.members]
  );

  // 上次的篩選:每個人、每個專案各記一份(跟著帳號走,見 lib/paFilters.ts)。
  // 從階段 Dashboard、「輪到我」之類的連結帶著條件進來時,以連結為準、不套用上次的。
  const [filtersReady, setFiltersReady] = useState(false);
  useEffect(() => {
    const apply = (f: SavedFilters) => {
      setPhaseFilter((f.phase as PhaseKey | null) ?? null);
      setOwnerFilter(f.owner);
      setMine(f.mine);
      setOwned(f.owned);
      setOverdue(f.overdue);
      setStageFilter((f.stage as typeof stageFilter) ?? null);
      setHideAlts(f.hideAlts);
      setShowExcluded(f.showExcluded);
      setShowRemoved(f.showRemoved);
    };
    const fromLink = props.initialMine || props.initialOverdue || props.initialPhase || props.initialRej;
    let alive = true;
    const local = fromLink ? null : localFilters(projectId);
    if (local) apply(local);
    if (fromLink || local) setFiltersReady(true);
    else
      // 這台瀏覽器沒記過(換電腦):問伺服器,回來之前不存,免得拿預設值蓋掉伺服器上的
      serverFilters(projectId).then((f) => {
        if (!alive) return;
        if (f) apply(f);
        setFiltersReady(true);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  useEffect(() => {
    if (!filtersReady) return;
    saveFilters(projectId, { phase: phaseFilter, owner: ownerFilter, mine, owned, overdue, stage: stageFilter, hideAlts, showExcluded, showRemoved });
  }, [filtersReady, projectId, phaseFilter, ownerFilter, mine, owned, overdue, stageFilter, hideAlts, showExcluded, showRemoved]);

  // 欄位與欄寬跟著帳號走:打開時先拿伺服器上自己的設定
  useEffect(() => {
    syncColPrefs();
  }, []);
  const nameOf = useMemo(() => {
    const byId = new Map(props.members.map((m) => [m.user_id, m.name]));
    return (id: string) => byId.get(id) ?? (id ? "（已不是成員）" : "");
  }, [props.members]);

  // 一顆料的負責人(Sourcer owner、RD owner)用同一種 key 表示,篩選與選單共用:
  // 真帳號 = id;預約中(已邀請還沒上線)= pending:信箱;兩個都沒指定 = "none"
  const ownerKeys = useCallback((p: PartRow): string[] => {
    const out: string[] = [];
    for (const k of ["sourcer_owner", "rd_owner"] as const) {
      const id = p[k];
      if (id) out.push(id);
      else if (p.pending_owner?.[k]) out.push(`pending:${p.pending_owner[k]!.email.toLowerCase()}`);
    }
    return out.length ? [...new Set(out)] : ["none"];
  }, []);
  // 階段下拉選單每一項後面的料件數(跟階段表同一個算法:不含已不在 BOM 的)
  const phaseCounts = useMemo(() => {
    const m: Partial<Record<PhaseKey, number>> = {};
    for (const p of parts) if (!p.removed_from_bom) m[p.ev.phase] = (m[p.ev.phase] ?? 0) + 1;
    return m;
  }, [parts]);
  const ownerOptions = useMemo(() => {
    const m = new Map<string, { key: string; name: string; n: number }>();
    for (const p of parts) {
      if (p.removed_from_bom || p.excluded) continue;
      for (const key of ownerKeys(p)) {
        const name = key === "none" ? "（沒有負責人）" : key.startsWith("pending:") ? (
          (["sourcer_owner", "rd_owner"] as const).map((k) => p.pending_owner?.[k]).find((x) => x && `pending:${x.email.toLowerCase()}` === key)?.name ?? key
        ) : nameOf(key);
        const cur = m.get(key) ?? { key, name, n: 0 };
        cur.n++;
        m.set(key, cur);
      }
    }
    return [...m.values()].sort((a, b) => (a.key === "none" ? 1 : b.key === "none" ? -1 : a.name.localeCompare(b.name)));
  }, [parts, ownerKeys, nameOf]);
  useEffect(() => {
    if (ownerFilter && !ownerOptions.some((o) => o.key === ownerFilter)) setOwnerFilter("");
  }, [ownerFilter, ownerOptions]);

  const applyDetail = useCallback((d: PartDetail) => {
    setParts((prev) => prev.map((p) => (p.id === d.part.id ? d.part : p)));
  }, []);

  const startEdit = useCallback((id: string, key: string) => setEditing({ id, key }), []);
  const cancelEdit = useCallback(() => setEditing(null), []);
  const openPart = useCallback((id: string) => setOpenId(id), []);
  const toggleSelect = useCallback((id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // 穩定的參考，Row 才 memo 得起來
  const save = useCallback(
    async (part: PartRow, key: string, value: string | null) => {
      setEditing(null);
      if ((part[key as keyof Part] ?? "") === (value ?? "")) return;
      setError(null);
      // 先在畫面上套用（Status 與紅黃燈用同一支 evalPart 現算），不要讓使用者盯著
      // 舊值等伺服器回來——雲端一趟來回是幾百毫秒起跳。回來之後以伺服器的為準，
      // 失敗就把那一列還原並說明原因。
      const guess: PartRow = { ...part, [key]: value } as PartRow;
      guess.ev = evalPart(guess, guess.issues, sla, today);
      const replace = (row: PartRow) => setParts((prev) => prev.map((p) => (p.id === row.id ? row : p)));
      replace(guess);
      try {
        const r = await api<{ part: PartRow }>(`/api/pa/projects/${projectId}/parts/${part.id}?slim=1`, {
          method: "PATCH",
          json: { field: key, value },
        });
        replace(r.part);
      } catch (e) {
        replace(part);
        setError(`${part.part_pn}：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [projectId, sla, today]
  );

  const addNote = useCallback(
    async (part: PartRow, date: string, text: string) => {
      setEditing(null);
      const body = text.trim();
      if (!body) return;
      setError(null);
      const replace = (row: PartRow) => setParts((prev) => prev.map((p) => (p.id === row.id ? row : p)));
      // 先掛上去,伺服器回來再以它為準
      replace({ ...part, recent_notes: [{ date, text: body }, ...part.recent_notes] });
      try {
        const d = await api<PartDetail>(`/api/pa/projects/${projectId}/parts/${part.id}/notes`, {
          json: { date, text: body },
        });
        replace(d.part);
      } catch (e) {
        replace(part);
        setError(`${part.part_pn}：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [projectId]
  );

  async function bulkSet(field: string, value: string | null) {
    const ids = [...selected];
    if (!ids.length) return;
    setError(null);
    try {
      const r = await api<{ parts: PartRow[]; today: string; changed: number }>(
        `/api/pa/projects/${projectId}/parts/bulk`,
        { json: { part_ids: ids, field, value } }
      );
      setParts(r.parts);
      setToday(r.today);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function setExcluded(excluded: boolean) {
    const ids = [...selected];
    if (!ids.length) return;
    setError(null);
    try {
      const r = await api<{ parts: PartRow[]; today: string; changed: number }>(
        `/api/pa/projects/${projectId}/parts/exclude`,
        { json: { part_ids: ids, excluded } }
      );
      setParts(r.parts);
      setToday(r.today);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const options = useMemo(() => {
    const uniq = (k: keyof Part) => [...new Set(parts.map((p) => String(p[k] ?? "")).filter(Boolean))].sort();
    return { models: uniq("fg_model"), lifecycles: uniq("lifecycle") };
  }, [parts]);

  const live = useMemo(
    // 從 Dashboard 點「不需PA」時,不追蹤的那些當然要看得到
    () => parts.filter((p) => (showRemoved || !p.removed_from_bom) && (showExcluded || phaseFilter === "na" || !p.excluded)),
    [parts, showRemoved, showExcluded, phaseFilter]
  );

  const kpi = useMemo(() => {
    const active = parts.filter((p) => !p.removed_from_bom && !p.excluded);
    const redBy = Object.fromEntries(STAGES.map((s) => [s.key, active.filter((p) => p.ev[s.key].light === "red").length])) as Record<StageKey, number>;
    return {
      total: active.length,
      notStarted: active.filter((p) => !p.pa_start).length,
      approved: active.filter((p) => p.ev.approved).length,
      red: active.filter((p) => p.ev.red > 0).length,
      mine: active.filter((p) => p.ev.waitingOn.some((r) => roles.includes(r))).length,
      owned: me ? active.filter((p) => p.sourcer_owner === me || p.rd_owner === me).length : 0,
      missingType: active.filter((p) => p.ev.missingType).length,
      escalated: active.filter((p) => p.ev.escalated.length > 0).length,
      supplierLate: active.filter((p) => p.ev.supplier_update.light === "red").length,
      removed: parts.filter((p) => p.removed_from_bom && !p.excluded).length,
      excluded: parts.filter((p) => p.excluded).length,
      alts: active.filter((p) => p.alt_of_pn).length,
      redBy,
    };
  }, [parts, roles, me]);

  // 打字時先讓輸入框跟上，篩選慢一拍沒關係
  const deferredQ = useDeferredValue(q);
  const rows = useMemo(() => {
    const needle = deferredQ.trim().toLowerCase();
    let out = live.filter((p) => {
      if (
        needle &&
        ![p.part_pn, p.part_desc, p.main_pn, p.fg_pn, p.supplier, ...p.recent_notes.map((n) => n.text), nameOf(p.sourcer_owner), nameOf(p.rd_owner)].some((s) =>
          s.toLowerCase().includes(needle)
        )
      )
        return false;
      if (model && p.fg_model !== model) return false;
      if (lifecycle && p.lifecycle !== lifecycle) return false;
      if (ptype && (ptype === "(空白)" ? p.part_type : p.part_type !== ptype)) return false;
      if (mine && !p.ev.waitingOn.some((r) => roles.includes(r))) return false;
      if (owned && p.sourcer_owner !== me && p.rd_owner !== me) return false;
      if (ownerFilter && !ownerKeys(p).includes(ownerFilter)) return false;
      if (overdue && p.ev.red === 0) return false;
      if (hideAlts && p.alt_of_pn) return false;
      if (stageFilter === "approved" && !p.ev.approved) return false;
      if (stageFilter === "missingType" && !p.ev.missingType) return false;
      if (stageFilter === "escalated" && !p.ev.escalated.length) return false;
      if (stageFilter === "supplier_update" && p.ev.supplier_update.light !== "red") return false;
      if (phaseFilter && p.ev.phase !== phaseFilter) return false;
      if (rejFilter && p.issues.filter((i) => i.dept === "QA").length !== rejFilter) return false;
      if (stageFilter && STAGE_KEYS.has(stageFilter) && p.ev[stageFilter as StageKey].light !== "red") return false;
      return true;
    });
    if (sort) {
      const val = (p: PartRow) =>
        sort.key === "phase"
            ? PHASE_ORDER.get(p.ev.phase) ?? 0
          : sort.key === "rd_issues" || sort.key === "qa_issues"
            ? p.issues.filter((i) => i.dept === (sort.key === "rd_issues" ? "RD" : "QA")).length
            : sort.key === "recent_notes"
              ? p.recent_notes[0]?.date ?? ""
              : sort.key === "sourcer_owner" || sort.key === "rd_owner"
                ? nameOf(p[sort.key])
                : sort.key === "supplier_update_qa" || sort.key === "supplier_update_rd"
                  ? p.ev[sort.key].from ?? ""
                : String(p[sort.key as keyof Part] ?? "");
      out = [...out].sort((a, b) => {
        const x = val(a), y = val(b);
        // 空白永遠排最後
        if (x === "" && y !== "") return 1;
        if (y === "" && x !== "") return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
      });
    }
    return out;
  }, [live, deferredQ, model, lifecycle, ptype, mine, overdue, owned, ownerFilter, ownerKeys, me, nameOf, stageFilter, phaseFilter, rejFilter, sort, roles, hideAlts]);

  const bulkDateFields = useMemo(
    () => FIELDS.filter((f) => f.kind === "date" && canEditField(f.key, roles, isAdmin)),
    [roles, isAdmin]
  );
  const canBulkType = canEditField("part_type", roles, isAdmin);
  const canSelect = props.canManage || canBulkType || bulkDateFields.length > 0 || isAdmin || roles.length > 0;

  const cols = useMemo(() => COLS.filter((c) => !hidden.has(String(c.key))), [hidden]);
  const widthOf = useCallback((c: Col) => colW.get(String(c.key)) ?? c.w, [colW]);
  // 左邊那兩欄是黏住的,它們的 left 要跟著前面的欄寬走(拖曳時同步更新這兩個變數)
  const pickW = canSelect ? 34 : 0;
  const leftDesc = pickW + widthOf(COLS[0]);
  // 表格總寬 = 各欄寬度相加。**不要**改回 width: max-content —— 那樣 table-layout: fixed 的
  // 欄寬會被儲存格內容的最小寬度撐住,只放得大、縮不小(內容太長就讓它裁掉)。
  const totalW = useMemo(() => pickW + cols.reduce((n, c) => n + widthOf(c), 0), [cols, widthOf, pickW]);

  // 拖曳中的狀態放 ref:拖的時候只動 <col> 的 style,不重畫 140 幾列;放開才存起來。
  const drag = useRef<{ key: string; x0: number; from: number; base: number } | null>(null);

  const paintWidth = useCallback(
    (key: string, w: number, base: number) => {
      const col = document.querySelector<HTMLElement>(`col[data-col="${key}"]`);
      if (col) col.style.width = `${w}px`;
      const table = document.querySelector<HTMLElement>("table.pa");
      // 表格總寬要跟著走,不然那一欄縮掉的寬度會被其他欄吃掉
      if (table) table.style.width = `${base + w}px`;
      // 拖的是第一欄的話,黏住的品名欄要跟著往右讓位
      if (key === "part_pn") table?.style.setProperty("--pa-left-desc", `${pickW + w}px`);
    },
    [pickW]
  );

  /** 表頭右緣往左右拖。起點寬度用**畫面上量到的**,不是設定值——兩者若不一致
   *  (例如瀏覽器縮放、或這一欄還沒存過寬度),用設定值會讓往左拉算出比現在更寬的值,
   *  看起來就變成「只放得大、縮不小」。 */
  const onResizeDown = useCallback((e: React.PointerEvent<HTMLSpanElement>, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.closest("th");
    const from = th ? th.getBoundingClientRect().width : 0;
    drag.current = { key, x0: e.clientX, from, base: totalW - from };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("pa-resizing");
  }, [totalW]);

  const onResizeMove = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      const d = drag.current;
      if (!d) return;
      paintWidth(d.key, clampColW(d.from + e.clientX - d.x0), d.base);
    },
    [paintWidth]
  );

  const onResizeUp = useCallback((e: React.PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove("pa-resizing");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    writeColWidth(d.key, clampColW(d.from + e.clientX - d.x0));
  }, []);
  const toggleCol = useCallback(
    (key: string) => {
      const next = new Set(hidden);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeHiddenCols(next);
    },
    [hidden]
  );

  const myCols = new Set(COLS.filter((c) => canEditField(c.key, roles, false)).map((c) => c.key));
  if (roles.includes("rd")) myCols.add("rd_issues");
  if (roles.includes("qa")) myCols.add("qa_issues");

  const clickSort = (key: ColKey) =>
    setSort((s) => (s?.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null));

  const kpiBtn = (key: typeof stageFilter, n: number, label: string, cls = "") => (
    <button
      // 這幾顆有一部分是 STAGES.map() 產生的,key 放在這裡才不會缺
      key={String(key)}
      className={`kpi ${cls} ${stageFilter === key ? "on" : ""}`}
      onClick={() => setStageFilter((s) => (s === key ? null : key))}
      title="點一下只看這些"
    >
      <span className="n">{n}</span>
      <span className="l">{label}</span>
    </button>
  );

  const filtersOn = q || ownerFilter || model || lifecycle || ptype || mine || overdue || stageFilter || phaseFilter || rejFilter || hideAlts;
  const open = openId ? parts.find((p) => p.id === openId) ?? null : null;

  return (
    <div className="trackerwrap">
      <div className="kpis">
        <div className="kpi">
          <span className="n">{kpi.total}</span>
          <span className="l">料號</span>
        </div>
        <div className="kpi">
          <span className="n">{kpi.notStarted}</span>
          <span className="l">尚未發起</span>
        </div>
        {/* 照流程順序:未發起 → 通知供應商 → 收齊資料 → (退件後)供應商更新 → RD/QA pass → 全部 pass */}
        {kpi.missingType > 0 && kpiBtn("missingType", kpi.missingType, "缺屬性（算不出期限）", "red")}
        {STAGES.filter((s) => s.key === "supplier_notified" || s.key === "docs_received").map((s) =>
          kpiBtn(s.key, kpi.redBy[s.key], `逾期：${s.label}`, kpi.redBy[s.key] ? "red" : ""))}
        {kpiBtn("supplier_update", kpi.supplierLate, "逾期：供應商更新", kpi.supplierLate ? "red" : "")}
        {STAGES.filter((s) => s.key === "rd_pass" || s.key === "qa_pass").map((s) =>
          kpiBtn(s.key, kpi.redBy[s.key], `逾期：${s.label}`, kpi.redBy[s.key] ? "red" : ""))}
        {kpi.escalated > 0 && kpiBtn("escalated", kpi.escalated, `退件 ≥${ESCALATE_AT} 次，需協助`, "red")}
        {kpiBtn("approved", kpi.approved, "RD + QA 皆 pass", "good")}
        <div className="legend">
          <span><i className="swatch red" />未完成且超過 SLA</span>
          <span><i className="swatch yellow" />已完成但超過 SLA</span>
          {roles.length > 0 && <span><i className="swatch mine" />輪到你填</span>}
        </div>
      </div>

      <div className="toolbar">
        <input type="search" placeholder="搜尋料號、品名、供應商" value={q} onChange={(e) => setQ(e.target.value)} />
        <select
          value={phaseFilter ?? ""}
          onChange={(e) => setPhaseFilter((e.target.value || null) as PhaseKey | null)}
          aria-label="階段"
        >
          <option value="">全部階段</option>
          {PHASES.map((ph) => (
            <option key={ph.key} value={ph.key}>
              {ph.label}（{phaseCounts[ph.key] ?? 0}）
            </option>
          ))}
        </select>
        {rejFilter && (
          <button className="btn btn-sm btn-toggle on" onClick={() => setRejFilter(null)} title="點一下取消">
            QA 退件 {rejFilter} 次 ✕
          </button>
        )}
        <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} aria-label="負責人">
          <option value="">全部負責人</option>
          {ownerOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.name}（{o.n}）
            </option>
          ))}
        </select>
        {roles.length > 0 && (
          <button className={`btn btn-sm btn-toggle ${mine ? "on" : ""}`} onClick={() => setMine((v) => !v)}>
            輪到我的（{kpi.mine}）
          </button>
        )}
        {kpi.owned > 0 && (
          <button className={`btn btn-sm btn-toggle ${owned ? "on" : ""}`} onClick={() => setOwned((v) => !v)}>
            我負責的（{kpi.owned}）
          </button>
        )}
        <button className={`btn btn-sm btn-toggle ${overdue ? "on" : ""}`} onClick={() => setOverdue((v) => !v)}>
          只看逾期（{kpi.red}）
        </button>
        <button
          className={`btn btn-sm btn-toggle ${stageFilter === "supplier_update" ? "on" : ""}`}
          onClick={() => setStageFilter((s) => (s === "supplier_update" ? null : "supplier_update"))}
          title="RD/QA 退件後，供應商超過 SLA 還沒送回更新資料"
        >
          供應商更新逾期（{kpi.supplierLate}）
        </button>
        {kpi.alts > 0 && (
          <button className={`btn btn-sm btn-toggle ${hideAlts ? "on" : ""}`} onClick={() => setHideAlts((v) => !v)}>
            隱藏替代料（{kpi.alts}）
          </button>
        )}
        <div className="colmenu">
          <button className={`btn btn-sm btn-toggle ${hidden.size ? "on" : ""}`} onClick={() => setColMenu((v) => !v)}>
            欄位（{cols.length}/{COLS.length}）
          </button>
          {colMenu && (
            <>
              <div className="colmenu-bg" onClick={() => setColMenu(false)} />
              <div className="colmenu-pop">
                <div className="colmenu-head">
                  <b>顯示哪幾欄</b>
                  <button className="btn btn-sm btn-ghost" onClick={() => writeHiddenCols(new Set())}>
                    全部顯示
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => writeHiddenCols(new Set(HIDDEN_DEFAULT))}>
                    還原預設
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={resetColWidths} title="把所有欄寬回到預設">
                    欄寬還原
                  </button>
                </div>
                {cols.map((c) => {
                  const key = String(c.key);
                  const fixed = ALWAYS.includes(key);
                  return (
                    <label key={key} className="colmenu-row">
                      <input
                        type="checkbox"
                        checked={!hidden.has(key)}
                        disabled={fixed}
                        onChange={() => toggleCol(key)}
                      />
                      <span>{c.label}</span>
                      {c.who && <span className="muted" style={{ fontSize: 11 }}>{c.who}</span>}
                    </label>
                  );
                })}
                <div className="muted" style={{ fontSize: 11.5, padding: "6px 10px 2px" }}>
                  收起來的欄位不會被清空,點開料號側欄一樣看得到、改得到。
                </div>
              </div>
            </>
          )}
        </div>
        {kpi.excluded > 0 && (
          <button className={`btn btn-sm btn-toggle ${showExcluded ? "on" : ""}`} onClick={() => setShowExcluded((v) => !v)}>
            顯示不追蹤的（{kpi.excluded}）
          </button>
        )}
        {kpi.removed > 0 && (
          <button className={`btn btn-sm btn-toggle ${showRemoved ? "on" : ""}`} onClick={() => setShowRemoved((v) => !v)}>
            含已不在 BOM（{kpi.removed}）
          </button>
        )}
        {filtersOn && (
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setQ(""); setOwnerFilter(""); setModel(""); setLifecycle(""); setPtype(""); setMine(false); setOverdue(false); setStageFilter(null); setPhaseFilter(null); setRejFilter(null); setHideAlts(false);
            }}
          >
            清除篩選
          </button>
        )}
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          {rows.length} / {live.length} 筆・今天 {today}
        </span>
      </div>

      {canSelect && selected.size > 0 && (
        <div className="toolbar bulkbar">
          <b>已選 {selected.size} 筆</b>

          {canBulkType && (
            <span className="bulkgroup">
              屬性
              {PART_TYPES.map((t) => (
                <button key={t} className="btn btn-sm" onClick={() => bulkSet("part_type", t)}>
                  {t}
                </button>
              ))}
              <button className="btn btn-sm btn-ghost" onClick={() => bulkSet("part_type", "")}>
                清除
              </button>
            </span>
          )}

          {bulkDateFields.length > 0 && (
            <span className="bulkgroup">
              <select value={bulkField} onChange={(e) => setBulkField(e.target.value)} aria-label="要批次填的日期欄位">
                <option value="">選日期欄位…</option>
                {bulkDateFields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={bulkDate}
                onChange={(e) => setBulkDate(e.target.value)}
                aria-label="日期"
                disabled={!bulkField}
              />
              <button className="btn btn-sm" disabled={!bulkField} onClick={() => bulkSet(bulkField, bulkDate || today)}>
                填 {bulkDate || today}
              </button>
              <button className="btn btn-sm btn-ghost" disabled={!bulkField} onClick={() => bulkSet(bulkField, null)}>
                清除
              </button>
            </span>
          )}

          {canSelect && (
            <span className="bulkgroup">
              <button className="btn btn-sm" onClick={() => setExcluded(true)} title="母階組件之類不用做 PA 的料號">
                排除，不做 PA 追蹤
              </button>
              <button className="btn btn-sm" onClick={() => setExcluded(false)}>
                恢復追蹤
              </button>
            </span>
          )}

          <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
            取消選取
          </button>
        </div>
      )}

      {error && (
        <div className="err" style={{ margin: "8px 16px 0" }} role="alert">
          {error}{" "}
          <button className="btn btn-sm btn-ghost" onClick={() => setError(null)}>關閉</button>
        </div>
      )}

      {parts.length === 0 ? (
        <div className="card empty" style={{ margin: 16 }}>
          這個專案還沒有料號。
          {props.canManage ? (
            <>
              {" "}<Link href={`/pa/p/${projectId}/import`} className="btn btn-accent btn-sm">匯入 BOM</Link>
            </>
          ) : " 請 PM 匯入 BOM。"}
        </div>
      ) : (
        <div className="tablescroll">
          <table
            className={`pa${canSelect ? " has-pick" : ""}`}
            style={{ width: totalW, ["--pa-left-pn" as string]: `${pickW}px`, ["--pa-left-desc" as string]: `${leftDesc}px` }}
          >
            <colgroup>
              {canSelect && <col style={{ width: 34 }} />}
              {cols.map((c) => (
                <col key={c.key} data-col={String(c.key)} style={{ width: widthOf(c) }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {canSelect && (
                  <th className="stick c-pick">
                    <input
                      type="checkbox"
                      aria-label="全選"
                      checked={rows.length > 0 && rows.every((p) => selected.has(p.id))}
                      onChange={(e) =>
                        setSelected(e.target.checked ? new Set(rows.map((p) => p.id)) : new Set())
                      }
                    />
                  </th>
                )}
                {cols.map((c) => (
                  <th key={c.key} className={`${c.sticky ? `stick ${c.sticky}` : ""} ${myCols.has(c.key) ? "mine-col" : ""}`}>
                    <button onClick={() => clickSort(c.key)} title="點一下排序">
                      {c.label}
                      {sort?.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                      {c.who && <span className="who">{c.who}</span>}
                    </button>
                    {/* 右緣拖曳調欄寬（雙擊回到預設） */}
                    <span
                      className="colresize"
                      role="separator"
                      aria-label={`調整${c.label}欄寬`}
                      title="拖曳調整欄寬，雙擊還原"
                      onPointerDown={(e) => onResizeDown(e, String(c.key))}
                      onPointerMove={onResizeMove}
                      onPointerUp={onResizeUp}
                      onPointerCancel={onResizeUp}
                      onDoubleClick={() => writeColWidth(String(c.key), c.w)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <Row
                  key={p.id}
                  p={p}
                  selectable={canSelect}
                  selected={selected.has(p.id)}
                  onSelect={toggleSelect}
                  sla={sla}
                  roles={roles}
                  isAdmin={isAdmin}
                  editing={editing?.id === p.id ? editing.key : null}
                  onEdit={startEdit}
                  onCancel={cancelEdit}
                  onSave={save}
                  onOpen={openPart}
                  today={today}
                  owners={owners}
                  nameOf={nameOf}
                  cols={cols}
                  onAddNote={addNote}
                />
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="empty">沒有符合篩選條件的料號</div>}
        </div>
      )}

      {open && (
        <PartDrawer
          projectId={projectId}
          partId={open.id}
          roles={roles}
          isAdmin={isAdmin}
          sla={sla}
          me={me}
          members={props.members}
          canManage={props.canManage}
          onClose={() => setOpenId(null)}
          onChanged={applyDetail}
        />
      )}
    </div>
  );
}

/** memo：改一格、勾一列都不該讓另外 140 幾列跟著重畫 */
const Row = memo(function Row({
  p, sla, roles, isAdmin, editing, onEdit, onCancel, onSave, onOpen, today, selectable, selected, onSelect, owners, nameOf, cols, onAddNote,
}: {
  p: PartRow;
  onAddNote: (part: PartRow, date: string, text: string) => void;
  owners: Record<string, { id: string; name: string }[]>;
  nameOf: (id: string) => string;
  cols: Col[];
  selectable: boolean;
  selected: boolean;
  onSelect: (id: string, on: boolean) => void;
  sla: Sla;
  roles: Role[];
  isAdmin: boolean;
  editing: string | null;
  onEdit: (id: string, key: string) => void;
  onCancel: () => void;
  onSave: (part: PartRow, key: string, v: string | null) => void;
  onOpen: (id: string) => void;
  today: string;
}) {
  const issueCount = (dept: "RD" | "QA") => p.issues.filter((i) => i.dept === dept);
  const shown = new Set(cols.map((c) => String(c.key)));
  return (
    <tr className={p.removed_from_bom || p.excluded ? "removed" : ""}>
      {selectable && (
        <td className="stick c-pick">
          <input type="checkbox" aria-label={`選取 ${p.part_pn}`} checked={selected} onChange={(e) => onSelect(p.id, e.target.checked)} />
        </td>
      )}
      {cols.map((c) => {
        const cls = [c.sticky ? `stick ${c.sticky}` : ""];
        if (c.key === "part_pn")
          return (
            <td key={c.key} className={cls.join(" ")}>
              <div className="v link mono" onClick={() => onOpen(p.id)} title="開啟詳細資料">
                {p.part_pn}
                {p.alt_of_pn && (
                  <span className="chip" title={`${p.alt_of_pn} 的替代料（Find Num ${p.find_num}）`}>
                    替代
                  </span>
                )}
                {Boolean(p.excluded) && <span className="chip" title={p.excluded_note}>不追蹤</span>}
                {p.ev.escalated.length > 0 && (
                  <span className="chip warn" title={`${p.ev.escalated.join("、")} 退件已達 ${ESCALATE_AT} 次，請 PM 協助`}>
                    需協助
                  </span>
                )}
              </div>
            </td>
          );
        if (c.key === "part_desc")
          return (
            <td key={c.key} className={cls.join(" ")}>
              <div className="v link" onClick={() => onOpen(p.id)} title={p.part_desc}>
                {p.part_desc}
              </div>
            </td>
          );
        if (c.key === "phase") {
          const ph = PHASE_BY_KEY[p.ev.phase];
          return (
            <td key={c.key}>
              <div className="v link" onClick={() => onOpen(p.id)} title={`${ph.desc}（負責：${ph.owner}）`}>
                <span className={`phase-chip ph-${ph.key}`}>{ph.label}</span>
              </div>
            </td>
          );
        }
        if (c.key === "recent_notes") {
          const canNote = !p.removed_from_bom && !p.excluded;
          if (editing === c.key)
            return (
              <td key={c.key} className="c-notes">
                <NoteEditor today={today} onSave={(d, t) => onAddNote(p, d, t)} onCancel={onCancel} />
              </td>
            );
          return (
            <td key={c.key} className="c-notes">
              <div
                className={`notes${canNote ? " editable" : ""}`}
                onClick={canNote ? () => onEdit(p.id, "recent_notes") : undefined}
                title={canNote ? "點一下記一筆進度" : undefined}
              >
                {p.recent_notes.map((n, i) => (
                  <div key={`${n.date}-${i}`} className="noteline">
                    <span className="mono">{shortDate(n.date)}</span>
                    <span>{n.text}</span>
                  </div>
                ))}
                {canNote && <span className="hint">＋ 記一筆</span>}
              </div>
            </td>
          );
        }
        if (c.key === "supplier_update_qa" || c.key === "supplier_update_rd") {
          const su = p.ev[c.key];
          // 這個部門最後一筆退件、供應商哪天補件、花了幾天(補完之後欄位不能變空白)
          const dept = c.key === "supplier_update_qa" ? "QA" : "RD";
          let lastIss: (typeof p.issues)[number] | null = null;
          for (const i of p.issues) if (i.dept === dept && (!lastIss || i.date >= lastIss.date)) lastIss = i;
          // 退件紀錄上的補件日,或 Sourcer 回填的「供應商更新資料日期」(要在退件之後),取較晚的
          const sup = p.supplier_updated && (!lastIss || p.supplier_updated >= lastIss.date) ? p.supplier_updated : null;
          const back = [lastIss?.resubmitted ?? null, sup].filter((x): x is string => Boolean(x)).sort().pop() ?? null;
          const took = back && lastIss ? daysBetween(lastIss.date, back) : null;
          const slow = took !== null && took > sla.supplier_update;
          const rejN = p.issues.filter((i) => i.dept === dept).length;
          const rejTag = rejN > 0 ? <span className="sub">・被退 {rejN} 次</span> : null;
          return (
            <td key={c.key} className={su.light === "red" ? "red" : !su.dept && slow ? "yellow" : ""} title={su.from ? `${su.dept} 退件日 ${su.from}，SLA ${sla.supplier_update} 天` : undefined}>
              <div className="v link" onClick={() => onOpen(p.id)} title="點開填供應商更新日期">
                {!su.dept && back ? (
                  <span title={lastIss ? `${dept} 退件 ${lastIss.date} → 供應商 ${back} 更新，用了 ${took} 天（SLA ${sla.supplier_update} 天）` : `供應商 ${back} 更新資料`}>
                    {shortDate(back)}
                    {slow && <span className="sub">超 {took! - sla.supplier_update} 天</span>}
                    {rejTag}
                  </span>
                ) : !su.dept ? (
                  <span className="hint">—</span>
                ) : su.light === "red" ? (
                  <span><b>逾期 {su.overBy} 天</b>{rejTag}</span>
                ) : (
                  <span><span className="hint">剩 {su.dueIn} 天</span>{rejTag}</span>
                )}
              </div>
            </td>
          );
        }
        if (c.key === "rd_issues" || c.key === "qa_issues") {
          const list = issueCount(c.key === "rd_issues" ? "RD" : "QA");
          return (
            <td key={c.key}>
              <div className="v link" onClick={() => onOpen(p.id)} title="點開記錄退件">
                {list.length ? (
                  <>
                    <span className="chip warn">{list.length} 次</span>
                    <span className="sub mono">{shortDate(list[list.length - 1].date)}</span>
                  </>
                ) : (
                  <span className="hint">—</span>
                )}
              </div>
            </td>
          );
        }

        const key = c.key as keyof Part;
        const editable = canEditField(key, roles, isAdmin) && !p.removed_from_bom && !p.excluded;
        const value = p[key] as string | null;
        const stage = STAGE_KEYS.has(key) ? STAGES.find((s) => s.key === key)! : null;
        // 這格要顯示哪一階的燈號/倒數:RD/QA 還沒開始 review 時,pass 的期限改掛在「開始 review」那格
        const hosted = STAGE_OF_START[key] ? STAGES.find((s) => s.key === STAGE_OF_START[key])! : null;
        const slaStage =
          hosted && slaColumn(p, hosted.key, true) === key
            ? hosted
            : stage && slaColumn(p, stage.key, shown.has(String(REVIEW_START[stage.key] ?? ""))) === key
              ? stage
              : null;
        const ev = slaStage ? p.ev[slaStage.key] : null;
        if (ev?.light) cls.push(ev.light);
        if (editable) cls.push("editable");
        const isDateCol = DATE_COLS.has(key);
        if (isDateCol) cls.push("date");
        // 輪到我：前一步已完成、這一步還空著、而且是我的角色
        const todo =
          editable &&
          !value &&
          (stage
            ? Boolean(stageStart(p, stage, p.issues))
            : hosted
              ? Boolean(stageStart(p, hosted, p.issues)) && !p[hosted.key]
              : key === "pa_start" ||
              (key === "part_type" && p.ev.missingType) ||
              (key === "plm_upload" && p.ev.approved) ||
              (key === "plm_released" && Boolean(p.plm_upload)) ||
              (key === "drawing_release" && p.hold_reason === "待RD圖面進版"));
        if (todo && roles.length) cls.push("todo");

        if (editing === key) {
          return (
            <td key={c.key} className={cls.join(" ")}>
              <CellEditor
                kind={c.key === "part_type" ? "type" : c.key in OWNER_ROLE ? "user" : c.key === "hold_reason" ? "hold" : isDateCol ? "date" : "text"}
                value={value}
                today={today}
                owners={owners[key] ?? []}
                onSave={(v) => onSave(p, key, v)}
                onCancel={onCancel}
              />
            </td>
          );
        }

        let content: React.ReactNode = value ? (isDateCol ? <span className="mono">{shortDate(value)}</span> : value) : null;
        if (c.key in OWNER_ROLE) {
          const pend = p.pending_owner?.[c.key as "sourcer_owner" | "rd_owner"];
          content = value ? nameOf(value) : pend ? <span title={`${pend.email}（已邀請，接受後自動成為 owner）`}>{pend.name}</span> : null;
        }
        if (c.key === "hold_reason" && value) {
          // 原因 + 負責人・卡關日期・已卡幾天。細節與歷史在側欄
          const since = p.hold_since;
          const info = [p.hold_owner ? nameOf(p.hold_owner) : null, since ? `${shortDate(since)} 起` : null, since ? `${daysBetween(since, today)} 天` : null]
            .filter(Boolean)
            .join("・");
          content = (
            <>
              <span className="chip warn" title={[holdHint(value), p.hold_note].filter(Boolean).join("\n")}>{value}</span>
              {info && <span className="sub">{info}</span>}
            </>
          );
        }
        if (slaStage && ev) {
          if (ev.light === "red") content = <span><b>逾期 {ev.overBy} 天</b></span>;
          else if (ev.light === "yellow") content = <><span className="mono">{shortDate(value)}</span><span className="sub">超 {ev.overBy} 天</span></>;
          else if (ev.dueIn !== null) content = <span className="hint">剩 {ev.dueIn} 天</span>;
          if (ev.orderError) content = <>{content}<span className="chip warn" title="完成日早於前一步">日期順序?</span></>;
          if (!value && slaStage.key === "docs_received" && p.supplier_notified && !p.part_type)
            content = <span className="hint">缺屬性</span>;
        }
        const title = slaStage && slaStage !== stage && stageStart(p, slaStage, p.issues)
          ? `還沒開始 review。${slaStage.label} 期限：SLA ${stageDays(p, slaStage, sla, p.issues) ?? "?"} 天，自 ${stageStart(p, slaStage, p.issues)} 起算`
          : stage && stageStart(p, stage, p.issues)
            ? `SLA ${stageDays(p, stage, sla, p.issues) ?? "?"} 天，自 ${stageStart(p, stage, p.issues)} 起算${value ? `；完成 ${value}` : ""}${slaStage ? "" : "（還沒開始 review，期限顯示在「開始 review」那格）"}`
            : value ?? undefined;

        return (
          <td key={c.key} className={cls.join(" ")} title={title}>
            <div
              className="v"
              onClick={key === "hold_reason" ? () => onOpen(p.id) : editable ? () => onEdit(p.id, key) : undefined}
              onKeyDown={key === "hold_reason" ? (e) => { if (e.key === "Enter") onOpen(p.id); } : editable ? (e) => { if (e.key === "Enter") onEdit(p.id, key); } : undefined}
              tabIndex={editable || key === "hold_reason" ? 0 : undefined}
              role={editable || key === "hold_reason" ? "button" : undefined}
            >
              {content ?? <span className="hint">{editable ? "＋" : ""}</span>}
            </div>
          </td>
        );
      })}
    </tr>
  );
});

/** 在格子裡直接記一筆進度:日期預設今天,Enter 送出、Esc 取消。 */
function NoteEditor({
  today, onSave, onCancel,
}: {
  today: string;
  onSave: (date: string, text: string) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(today);
  const [text, setText] = useState("");
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
    if (e.key === "Enter" && text.trim()) onSave(date, text);
  };
  return (
    <div
      className="celledit noteedit"
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        if (text.trim()) onSave(date, text);
        else onCancel();
      }}
    >
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} onKeyDown={keys} />
      <input
        autoFocus
        placeholder="例如：廠商資料處理中"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={keys}
      />
    </div>
  );
}

function CellEditor({
  kind, value, today, owners, onSave, onCancel,
}: {
  kind: "date" | "text" | "type" | "user" | "hold";
  value: string | null;
  today: string;
  owners: { id: string; name: string }[];
  onSave: (v: string | null) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(value ?? "");
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
    if (e.key === "Enter") onSave(v || null);
  };
  if (kind === "type")
    return (
      <div className="celledit">
        <select autoFocus value={v} onChange={(e) => onSave(e.target.value)} onBlur={onCancel} onKeyDown={keys}>
          <option value="">（未填）</option>
          {PART_TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
      </div>
    );
  if (kind === "hold")
    return (
      <div className="celledit">
        <select autoFocus value={v} onChange={(e) => onSave(e.target.value)} onBlur={onCancel} onKeyDown={keys}>
          <option value="">（無，照日期推）</option>
          {HOLD_REASONS.map((h) => <option key={h}>{h}</option>)}
        </select>
      </div>
    );
  if (kind === "user")
    return (
      <div className="celledit">
        <select autoFocus value={v} onChange={(e) => onSave(e.target.value)} onBlur={onCancel} onKeyDown={keys}>
          <option value="">（未指定）</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      </div>
    );
  if (kind === "text")
    return (
      <div className="celledit">
        <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={() => onSave(v.trim())} onKeyDown={keys} />
      </div>
    );
  return (
    <div
      className="celledit"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) onSave(v || null);
      }}
    >
      <input type="date" autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={keys} />
      <button className="btn" onMouseDown={(e) => e.preventDefault()} onClick={() => onSave(today)} title="填今天">今天</button>
      {value && <button className="btn" onMouseDown={(e) => e.preventDefault()} onClick={() => onSave(null)} title="清除">✕</button>}
    </div>
  );
}
