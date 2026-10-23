-- PA Tracker:Sourcer 回填「供應商更新資料」的日期(2026-10-14)。
-- Supabase → SQL Editor 貼上 → Run;重複執行是安全的。
alter table pa_parts add column if not exists supplier_updated text;

select 'PA supplier_updated ready' as status;
