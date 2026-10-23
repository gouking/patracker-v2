-- PA Tracker:記下「供應商更新資料日期」是什麼時候填的(2026-10-23)。
-- 同一天內「Sourcer 填供應商更新」與「QA/RD 記退件」誰先誰後,靠這個時間判斷:
-- 退件在更新之後記的 = 又被退件了,還在等供應商。
-- Supabase → SQL Editor 貼上 → Run;重複執行是安全的。
alter table pa_parts add column if not exists supplier_updated_at text;

-- 已經填過的,用修改紀錄裡最近一次填的時間補上
update pa_parts p set supplier_updated_at = h.at
  from (select part_id, max(at) as at from pa_part_history where field = 'supplier_updated' and new_value is not null group by part_id) h
 where h.part_id = p.id and p.supplier_updated is not null and p.supplier_updated_at is null;

select 'PA supplier_updated_at ready' as status;
