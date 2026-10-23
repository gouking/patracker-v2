-- PA Tracker 個人連線金鑰:讓別的程式(例如 QA 電腦上的 map_system)代表某個人呼叫 /api/pa/*。
-- 2026-10-08 加的。Supabase → SQL Editor 貼上 → Run;重複執行是安全的。
-- (sql/add_pa_tracker.sql 也有同樣的內容)
--
-- 只存雜湊(sha256),原始金鑰只在建立當下顯示一次。

create table if not exists pa_api_tokens (
  id            text primary key,
  user_id       text not null,
  name          text not null default '',
  token_hash    text not null unique,
  created_at    text not null,
  last_used_at  text,
  revoked       integer not null default 0
);
create index if not exists idx_pa_tokens_user on pa_api_tokens(user_id);
alter table pa_api_tokens enable row level security;

select 'PA API tokens ready' as status;
