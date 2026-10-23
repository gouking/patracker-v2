-- PA Tracker:同一顆料可以出現在不同成品底下(2026-10-14)。
-- 識別從 (專案, 主料, 料號) 改成 (專案, 成品料號, 主料, 料號)。重複執行是安全的。
alter table pa_parts drop constraint if exists pa_parts_project_id_main_pn_part_pn_key;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pa_parts_project_fg_main_pn_key' and conrelid = 'pa_parts'::regclass) then
    alter table pa_parts add constraint pa_parts_project_fg_main_pn_key unique (project_id, fg_pn, main_pn, part_pn);
  end if;
end $$;

select 'PA part per assembly ready' as status;
