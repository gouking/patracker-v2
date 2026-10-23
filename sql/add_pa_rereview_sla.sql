-- PA Tracker:SLA 新增「供應商補件後複審」天數(QA/RD 在供應商補件完之後要幾天內審完)。
-- Supabase → SQL Editor 貼上 → Run;重複執行是安全的。
alter table pa_global_sla add column if not exists rereview integer not null default 3;

select 'PA rereview SLA ready' as status;
