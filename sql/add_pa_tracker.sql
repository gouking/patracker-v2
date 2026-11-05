-- PA Tracker(零件承認追蹤)的資料表。
--
-- 從本機的 patracker(node:sqlite)搬過來,欄位與語意一模一樣,只有三點不同:
--   1. 表名一律加 pa_ 前綴 —— 跟甘特圖的資料表共用同一個 public schema
--   2. 使用者不另外存:直接用 public.profiles(id/email/name/role)
--   3. 日期一律 text 'YYYY-MM-DD'、時間戳記一律 text ISO 8601 —— 跟 Excel 同義,
--      也避免 pg 回傳 Date 物件之後時區又跑掉。旗標沿用 0/1 的 integer。
--
-- 這些表不開放給前端直接讀寫:enable RLS 但不給任何 policy,
-- 所以帶 anon/authenticated key 的 PostgREST 一律讀不到。
-- 伺服器端是用資料庫連線字串(DATABASE_URL)直連,不受 RLS 限制,
-- 權限由 src/server/pa/ 的程式逐欄檢查(跟本機版同一套規則)。
--
-- 執行方式:Supabase → SQL Editor → 貼上整份 → Run。重複執行是安全的。

create table if not exists pa_projects (
  id          text primary key,
  name        text not null,
  code        text not null default '',
  created_by  text not null,
  archived    integer not null default 0,
  created_at  text not null,
  updated_at  text not null
);

-- 一人可以在同一個專案身兼多個角色,所以 (project, user, role) 才是主鍵
create table if not exists pa_project_members (
  project_id  text not null references pa_projects(id) on delete cascade,
  user_id     text not null,
  role        text not null,  -- pm | sourcer | rd | qa
  created_at  text not null,
  primary key (project_id, user_id, role)
);
create index if not exists idx_pa_members_user on pa_project_members(user_id);

-- 預設值 = 原 Excel「工作表1」C16:C20
create table if not exists pa_sla_settings (
  project_id         text primary key references pa_projects(id) on delete cascade,
  supplier_notified  integer not null default 3,
  docs_std           integer not null default 7,
  docs_custom        integer not null default 21,
  rd_pass            integer not null default 7,
  qa_pass            integer not null default 7
);

create table if not exists pa_parts (
  id                 text primary key,
  project_id         text not null references pa_projects(id) on delete cascade,
  fg_pn              text not null default '',
  fg_model           text not null default '',
  fg_desc            text not null default '',
  main_pn            text not null default '',
  part_pn            text not null,
  lifecycle          text not null default '',
  part_desc          text not null default '',
  part_type          text not null default '',  -- '' | 標準件 | 訂製件
  supplier           text not null default '',
  pa_start           text,
  supplier_notified  text,
  docs_received      text,
  rd_review_start    text,
  qa_review_start    text,
  rd_pass            text,
  qa_pass            text,
  plm_pa_start       text,
  first_article      text,
  sourcer_owner      text not null default '',  -- 這顆料由哪一位 Sourcer 在跟(profiles.id)
  removed_from_bom   integer not null default 0,  -- 最近一次匯入的 BOM 裡已經沒有(標記不刪)
  excluded           integer not null default 0,  -- 不列入 PA 追蹤(母階組件、或人工排除)
  excluded_note      text not null default '',
  -- 以下只有 PLM 的 BOM PDF 匯入才有:階層、實際上一階、Find Num、是誰的替代料、用量、位置
  bom_level          text not null default '',
  parent_pn          text not null default '',
  find_num           text not null default '',
  alt_of_pn          text not null default '',
  qty                text not null default '',
  ref_des            text not null default '',
  sort_order         integer not null default 0,
  created_at         text not null,
  updated_at         text not null,
  unique (project_id, fg_pn, main_pn, part_pn)
);
create index if not exists idx_pa_parts_project on pa_parts(project_id);
create index if not exists idx_pa_parts_owner on pa_parts(sourcer_owner) where sourcer_owner <> '';

-- 進度紀錄:原本 Excel 的 remark 欄,一筆一條(日期＋文字＋誰寫的)
create table if not exists pa_part_notes (
  id          text primary key,
  part_id     text not null references pa_parts(id) on delete cascade,
  date        text not null,
  text        text not null,
  created_by  text not null,
  created_at  text not null
);
create index if not exists idx_pa_notes_part on pa_part_notes(part_id, date);

-- 取代 Excel R/S 欄「Review iteration record」:每次退件給供應商記一筆
create table if not exists pa_review_issues (
  id          text primary key,
  part_id     text not null references pa_parts(id) on delete cascade,
  dept        text not null,  -- RD | QA
  date        text not null,
  note        text not null default '',
  created_by  text not null,
  created_at  text not null
);
create index if not exists idx_pa_issues_part on pa_review_issues(part_id);

create table if not exists pa_part_history (
  id          bigint generated always as identity primary key,
  part_id     text not null references pa_parts(id) on delete cascade,
  user_id     text not null,
  field       text not null,
  old_value   text,
  new_value   text,
  at          text not null
);
create index if not exists idx_pa_history_part on pa_part_history(part_id, at);

-- 每日逾期信寄過沒:(日期, 使用者) 當主鍵,重複觸發不會重寄
create table if not exists pa_digest_log (
  day      text not null,
  user_id  text not null,
  sent_at  text not null,
  ok       integer not null,
  primary key (day, user_id)
);

-- 流程圖最後一段(上傳 PLM → Released)與卡關原因,2026-10-06 加的(sql/add_pa_plm_stage.sql)
alter table pa_parts add column if not exists plm_upload   text;
alter table pa_parts add column if not exists plm_released text;
alter table pa_parts add column if not exists hold_reason  text not null default '';  -- '' | 待RD圖面進版 | ISSUE

-- 填了日期當下寄的通知:同一顆料同一件事只寄一次
create table if not exists pa_notify_log (
  part_id  text not null references pa_parts(id) on delete cascade,
  event    text not null,  -- start | docs | approved | escalate:RD | escalate:QA
  sent_at  text not null,
  primary key (part_id, event)
);

-- 個人連線金鑰(別的程式代表某個人呼叫 /api/pa/*),2026-10-08 加的(sql/add_pa_api_tokens.sql)
create table if not exists pa_api_tokens (
  id            text primary key,
  user_id       text not null,
  name          text not null default '',
  token_hash    text not null unique,  -- 只存 sha256,原始金鑰只在建立時顯示一次
  created_at    text not null,
  last_used_at  text,
  revoked       integer not null default 0
);
create index if not exists idx_pa_tokens_user on pa_api_tokens(user_id);

-- RD owner、承認樣品、圖面 Release、供應商更新資料與它的 SLA、個人欄位偏好,2026-10-08 加的
-- (sql/add_pa_owners_samples_prefs.sql)
alter table pa_parts add column if not exists rd_owner        text not null default '';
alter table pa_parts add column if not exists sample_received text;
alter table pa_parts add column if not exists supplier_updated text;  -- Sourcer 回填:供應商最近一次更新資料的日期
alter table pa_parts add column if not exists supplier_updated_at text; -- 上面那個日期是什麼時候填的(同一天內判斷先後)
alter table pa_parts add column if not exists drawing_release text;
create index if not exists idx_pa_parts_rd_owner on pa_parts(rd_owner) where rd_owner <> '';
alter table pa_review_issues add column if not exists resubmitted text;
alter table pa_sla_settings add column if not exists supplier_update integer not null default 7;
create table if not exists pa_user_prefs (
  user_id     text not null,
  key         text not null,
  value       text not null,
  updated_at  text not null,
  primary key (user_id, key)
);

-- SLA 全公司一套、只有系統管理員能改,2026-10-08 加的(sql/add_pa_global_sla.sql)。
-- 只有一列(id = 1);上面的 pa_sla_settings(每個專案一份)不再讀取
create table if not exists pa_global_sla (
  id                 integer primary key check (id = 1),
  supplier_notified  integer not null default 3,
  docs_std           integer not null default 7,
  docs_custom        integer not null default 21,
  rd_pass            integer not null default 7,
  qa_pass            integer not null default 7,
  supplier_update    integer not null default 7,
  rereview           integer not null default 3,
  updated_at         text,
  updated_by         text
);
insert into pa_global_sla (id) values (1) on conflict (id) do nothing;

-- ---------- 誰讀得到 ----------
-- 一律 enable RLS 且不給 policy:前端拿 anon/authenticated key 打 PostgREST 一律讀不到,
-- 只有伺服器端用資料庫連線字串直連的程式碼看得到(它自己逐欄檢查權限)。
alter table pa_projects        enable row level security;
alter table pa_project_members enable row level security;
alter table pa_sla_settings    enable row level security;
alter table pa_parts           enable row level security;
alter table pa_review_issues   enable row level security;
alter table pa_part_notes      enable row level security;
alter table pa_part_history    enable row level security;
alter table pa_digest_log      enable row level security;
alter table pa_notify_log      enable row level security;
alter table pa_api_tokens      enable row level security;
alter table pa_user_prefs      enable row level security;
alter table pa_global_sla      enable row level security;

-- emails:多個信箱用換行或逗號隔開,存原文,送信時才拆。

create table if not exists pa_suppliers (
  id          text primary key,
  name        text not null,
  emails      text not null default '',
  contact     text not null default '',
  note        text not null default '',
  updated_at  text,
  updated_by  text
);
create unique index if not exists pa_suppliers_name_uq on pa_suppliers (lower(name));
alter table pa_suppliers enable row level security;

alter table pa_global_sla add column if not exists rereview integer not null default 3;

-- 同一顆料可以出現在不同成品底下(2026-10-14):識別改成 成品料號＋主料＋料號
alter table pa_parts drop constraint if exists pa_parts_project_id_main_pn_part_pn_key;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pa_parts_project_fg_main_pn_key' and conrelid = 'pa_parts'::regclass) then
    alter table pa_parts add constraint pa_parts_project_fg_main_pn_key unique (project_id, fg_pn, main_pn, part_pn);
  end if;
end $$;

create table if not exists pa_pending_owners (
  part_id  text not null references pa_parts(id) on delete cascade,
  field    text not null,
  email    text not null,
  primary key (part_id, field)
);
create index if not exists pa_pending_owners_email_idx on pa_pending_owners (lower(email));
alter table pa_pending_owners enable row level security;

-- 每日催供應商信的寄送紀錄(2026-10-19)
create table if not exists pa_supplier_chase_log (
  day          text not null,
  supplier_key text not null,
  to_email     text not null default '',
  sent_at      text not null,
  ok           integer not null,
  primary key (day, supplier_key)
);
alter table pa_supplier_chase_log enable row level security;

-- PA Tracker:卡關原因加上「卡關日期、負責人、備註、完成日期」,並留下每一次卡關的歷史(2026-11-05)
-- Supabase → SQL Editor 貼上 → Run;重複執行是安全的。(sql/add_pa_tracker.sql 也有同樣的內容)
--
-- 目前進行中的卡關還是放在 pa_parts(hold_reason 原本就在,階段與通知都靠它);
-- 這次多三欄:卡關日期、負責人、備註。卡關結束(填了完成日期)時整筆搬進 pa_part_holds 當歷史,
-- 料就回到日期推得出來的原本階段。

alter table pa_parts add column if not exists hold_since text;
alter table pa_parts add column if not exists hold_owner text not null default '';
alter table pa_parts add column if not exists hold_note  text not null default '';

create table if not exists pa_part_holds (
  id          text primary key,
  part_id     text not null references pa_parts(id) on delete cascade,
  reason      text not null,
  started     text not null,
  owner       text not null default '',
  note        text not null default '',
  resolved    text not null,
  resolved_by text not null default '',
  created_at  text not null
);
create index if not exists idx_pa_part_holds_part on pa_part_holds(part_id, resolved);
alter table pa_part_holds enable row level security;

-- 舊資料:已經在卡關的料,卡關日期用修改紀錄裡設定卡關原因的那天(找不到就用建立日)
update pa_parts as p set hold_since = coalesce(
  (select substr(max(h.at), 1, 10) from pa_part_history h where h.part_id = p.id and h.field = 'hold_reason' and coalesce(h.new_value, '') <> ''),
  substr(p.created_at, 1, 10))
 where coalesce(p.hold_reason, '') <> '' and p.hold_since is null;

select 'PA Tracker tables ready' as status;
