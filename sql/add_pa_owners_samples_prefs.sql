-- PA Tracker 2026-10-08:RD owner、承認樣品、圖面 Release、退件後「供應商更新資料」與它的 SLA、個人欄位偏好。
-- Supabase → SQL Editor 貼上 → Run;重複執行是安全的。(sql/add_pa_tracker.sql 也有同樣的內容)

-- 這顆料由哪一位 RD 在跟(profiles.id;空字串＝整組 RD 一起負責)
alter table pa_parts add column if not exists rd_owner        text not null default '';
-- 承認樣品收到日(Sourcer/採購填)、圖面 Release 日(RD 填)
alter table pa_parts add column if not exists sample_received text;
alter table pa_parts add column if not exists drawing_release text;
create index if not exists idx_pa_parts_rd_owner on pa_parts(rd_owner) where rd_owner <> '';

-- 退件之後,供應商哪一天送回更新的資料(空白＝還在等供應商)
alter table pa_review_issues add column if not exists resubmitted text;

-- 「供應商更新資料」的 SLA:自退件日起算幾天內要送回
alter table pa_sla_settings add column if not exists supplier_update integer not null default 7;

-- 每個人自己的畫面設定(追蹤表顯示哪幾欄、欄寬),跟著帳號走、換電腦也一樣
create table if not exists pa_user_prefs (
  user_id     text not null,
  key         text not null,
  value       text not null,
  updated_at  text not null,
  primary key (user_id, key)
);
alter table pa_user_prefs enable row level security;

select 'PA owners/samples/prefs ready' as status;
