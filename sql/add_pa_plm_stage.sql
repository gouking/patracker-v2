-- PA Tracker:流程圖最後一段(上傳 PLM → Released)、卡關原因、即時通知紀錄。
-- 2026-10-06 加的。Supabase → SQL Editor 貼上 → Run;重複執行是安全的。
-- (sql/add_pa_tracker.sql 也有同樣的內容,新裝的話跑那一份就夠)

alter table pa_parts add column if not exists plm_upload   text;
alter table pa_parts add column if not exists plm_released text;
-- '' | 待RD圖面進版 | ISSUE
alter table pa_parts add column if not exists hold_reason  text not null default '';

-- 填了日期當下寄的通知(發起→Sourcer、收齊→RD/QA、都 pass→Sourcer、退件滿 4 次→PM)。
-- 同一顆料同一件事只寄一次:日期填錯再改,不會再寄一封。
create table if not exists pa_notify_log (
  part_id  text not null references pa_parts(id) on delete cascade,
  event    text not null,  -- start | docs | approved | escalate:RD | escalate:QA
  sent_at  text not null,
  primary key (part_id, event)
);
alter table pa_notify_log enable row level security;

select 'PA PLM stage ready' as status;
