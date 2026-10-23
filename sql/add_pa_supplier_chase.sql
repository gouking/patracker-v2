-- PA Tracker:每日催供應商信的寄送紀錄(2026-10-19)。同一天同一家供應商只寄一次。
-- Supabase → SQL Editor 貼上 → Run;重複執行是安全的。
create table if not exists pa_supplier_chase_log (
  day          text not null,
  supplier_key text not null,
  to_email     text not null default '',
  sent_at      text not null,
  ok           integer not null,
  primary key (day, supplier_key)
);
alter table pa_supplier_chase_log enable row level security;

select 'PA supplier chase ready' as status;
