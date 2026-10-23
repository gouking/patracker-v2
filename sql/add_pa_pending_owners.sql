-- PA Tracker:還沒有帳號的人先預約成為某幾顆料的 owner(2026-10-14)。
-- 邀請的對象接受邀請、建好帳號的那一刻,系統自動把預約的料指給他(src/server/invite.ts)。
-- Supabase → SQL Editor 貼上 → Run;重複執行是安全的。
create table if not exists pa_pending_owners (
  part_id  text not null references pa_parts(id) on delete cascade,
  field    text not null,
  email    text not null,
  primary key (part_id, field)
);
create index if not exists pa_pending_owners_email_idx on pa_pending_owners (lower(email));
alter table pa_pending_owners enable row level security;

select 'PA pending owners ready' as status;
