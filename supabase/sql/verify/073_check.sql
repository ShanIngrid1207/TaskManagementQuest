-- Verify 073 on a DEV COPY (apply 072 then 073 first). Every SELECT should
-- return ok = true. Run as the service role / SQL editor.

-- 1. Column exists, NOT NULL, default '{}'.
select 'supervisor_ids column' as check,
       (data_type = 'ARRAY' and is_nullable = 'NO' and column_default like '%{}%') as ok
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles' and column_name = 'supervisor_ids';

-- 2. Backfill parity: every row that had a scalar has it as supervisor_ids[1],
--    and no row is null.
select 'backfill parity' as check,
       count(*) filter (
         where supervisor_ids is null
            or (supervisor_id is not null and (array_length(supervisor_ids,1) is null or supervisor_ids[1] <> supervisor_id))
       ) = 0 as ok
from public.profiles;

-- 3. Scalar mirror holds: supervisor_id always equals supervisor_ids[1] (or null).
select 'scalar mirror' as check,
       count(*) filter (
         where supervisor_id is distinct from (case when array_length(supervisor_ids,1) >= 1 then supervisor_ids[1] else null end)
       ) = 0 as ok
from public.profiles;

-- 4. Helper exists and is callable.
select 'reports_to_me helper' as check,
       exists (select 1 from pg_proc where proname = 'reports_to_me') as ok;

-- 5. No task policy still gates on the bare scalar supervisor_id.
select 'no scalar supervisor gate left' as check,
       count(*) = 0 as ok
from pg_policies
where schemaname = 'public' and tablename = 'tasks'
  and qual like '%supervisor_id = %current_member_id%';

-- 6. Self-supervisor guard present.
select 'self-supervisor guard' as check,
       exists (
         select 1 from pg_constraint
         where conname = 'profiles_not_self_supervisor'
       ) as ok;
