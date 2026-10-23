-- PA Tracker:SLA 改成全公司一套、只有系統管理員能改(2026-10-08 使用者決定)。
-- Supabase → SQL Editor 貼上 → Run;重複執行是安全的。(sql/add_pa_tracker.sql 也有同樣的內容)
--
-- 只有一列(id = 1)。第一次建立時沿用「最早建立、還沒封存的專案」原本的設定,
-- 這樣搬過來之後紅黃燈不會突然變;沒有專案就用預設值。
-- 舊的 pa_sla_settings(每個專案一份)不再讀取,資料先留著。

create table if not exists pa_global_sla (
  id                 integer primary key check (id = 1),
  supplier_notified  integer not null default 3,
  docs_std           integer not null default 7,
  docs_custom        integer not null default 21,
  rd_pass            integer not null default 7,
  qa_pass            integer not null default 7,
  supplier_update    integer not null default 7,
  updated_at         text,
  updated_by         text
);
insert into pa_global_sla (id, supplier_notified, docs_std, docs_custom, rd_pass, qa_pass, supplier_update)
select 1, s.supplier_notified, s.docs_std, s.docs_custom, s.rd_pass, s.qa_pass, s.supplier_update
  from pa_sla_settings s join pa_projects p on p.id = s.project_id
 where p.archived = 0
 order by p.created_at
 limit 1
on conflict (id) do nothing;
insert into pa_global_sla (id) values (1) on conflict (id) do nothing;
alter table pa_global_sla enable row level security;

select 'PA global SLA ready' as status;
