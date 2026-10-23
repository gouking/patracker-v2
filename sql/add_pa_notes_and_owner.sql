-- PA Tracker:每顆料的進度紀錄(原本 Excel 的 remark 欄)與 Sourcer owner。
--
-- 進度紀錄一筆一條(日期＋文字＋誰寫的),而不是一格多行文字 —— 這樣才知道
-- 「最後一次更新是什麼時候」,也才能在表格上顯示最新一條、據此提醒。
--
-- Supabase → SQL Editor 貼上整份執行。重複執行是安全的。

-- 這顆料由哪一位 Sourcer 在跟(profiles.id;空字串 = 沒指定,全專案的 Sourcer 一起負責)
alter table pa_parts add column if not exists sourcer_owner text not null default '';
create index if not exists idx_pa_parts_owner on pa_parts(sourcer_owner) where sourcer_owner <> '';

create table if not exists pa_part_notes (
  id          text primary key,
  part_id     text not null references pa_parts(id) on delete cascade,
  date        text not null,   -- 'YYYY-MM-DD',這一筆在講哪一天的事
  text        text not null,
  created_by  text not null,
  created_at  text not null
);
create index if not exists idx_pa_notes_part on pa_part_notes(part_id, date);

-- 跟其他 pa_ 資料表一樣:開 RLS 但不給 policy,只有伺服器端直連看得到
alter table pa_part_notes enable row level security;

select 'PA notes + sourcer owner ready' as status;
