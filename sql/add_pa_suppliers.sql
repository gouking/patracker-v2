-- PA Tracker:供應商清單與 Email(催供應商發信用)。所有登入的人都能維護。
-- Supabase → SQL Editor 貼上 → Run;重複執行是安全的。(sql/add_pa_tracker.sql 也有同樣的內容)
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

select 'PA suppliers ready' as status;
