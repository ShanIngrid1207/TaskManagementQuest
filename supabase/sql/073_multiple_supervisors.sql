-- 073: Multiple "reports to" supervisors.
--
-- Until now profiles.supervisor_id (migration 012) held a SINGLE team_members id:
-- a person reported to exactly one supervisor. The product now needs a person to
-- report to SEVERAL supervisors, where EACH of them sees that person's tasks and
-- time/workload — the same access a single supervisor has today.
--
-- Approach (mirrors the company_ids text[] pattern, migration 042):
--   1. Add profiles.supervisor_ids text[] NOT NULL DEFAULT '{}', backfilled from
--      the scalar supervisor_id.
--   2. Keep supervisor_id as a derived "primary" (= supervisor_ids[1]) via a
--      BEFORE trigger that syncs BOTH directions, so legacy writers (the
--      create-user edge fn, which writes supervisor_id) and legacy readers (the
--      check-in / notify seams) keep working untouched.
--   3. reports_to_me(sup_ids) helper + GIN index.
--   4. Guard: a person can't be their own supervisor (any slot).
--   5. Extend the self-update freeze so a worker can't self-edit supervisor_ids.
--   6. Re-issue the RLS policies that gate a supervisor to their reports, using
--      reports_to_me(p.supervisor_ids) in place of p.supervisor_id = current_member_id().
--
-- SEQUENCING: written against the POST-072 baseline (uses is_shared_bucket, added
-- by 072). Apply 072 first, then 073. Idempotent; transaction-wrapped.
-- RLS is the wall — apply on a DEV COPY and pass verify/073_check.sql BEFORE prod.

begin;

------------------------------------------------------------------------
-- 1. Array column + backfill.
------------------------------------------------------------------------
alter table public.profiles
  add column if not exists supervisor_ids text[];

update public.profiles
  set supervisor_ids = case
    when supervisor_id is null then '{}'::text[]
    else array[supervisor_id]
  end
  where supervisor_ids is null;

alter table public.profiles
  alter column supervisor_ids set default '{}'::text[];
alter table public.profiles
  alter column supervisor_ids set not null;

-- Fast "who reports to member X" lookups (the RLS subquery below).
create index if not exists profiles_supervisor_ids_idx
  on public.profiles using gin (supervisor_ids);

------------------------------------------------------------------------
-- 2. Two-way sync trigger: array is the source of truth, but a legacy write
--    that only sets the scalar (create-user edge fn) is promoted to the array.
------------------------------------------------------------------------
create or replace function public.sync_supervisor_columns()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- Legacy insert path that set only the scalar: seed the array from it.
    if (new.supervisor_ids is null or array_length(new.supervisor_ids, 1) is null)
       and new.supervisor_id is not null then
      new.supervisor_ids := array[new.supervisor_id];
    end if;
  elsif new.supervisor_ids is distinct from old.supervisor_ids then
    -- Array changed (the new client path) — array wins.
    null;
  elsif new.supervisor_id is distinct from old.supervisor_id then
    -- Only the scalar changed (legacy path) — promote it to the array.
    new.supervisor_ids := case
      when new.supervisor_id is null then '{}'::text[]
      else array[new.supervisor_id]
    end;
  end if;

  -- Primary scalar is always supervisor_ids[1] (or null when empty).
  new.supervisor_id := case
    when array_length(new.supervisor_ids, 1) >= 1 then new.supervisor_ids[1]
    else null
  end;
  return new;
end;
$$;

drop trigger if exists profiles_sync_supervisor on public.profiles;
create trigger profiles_sync_supervisor
  before insert or update on public.profiles
  for each row execute function public.sync_supervisor_columns();

------------------------------------------------------------------------
-- 3. reports_to_me helper (mirrors current_company_ids() style).
------------------------------------------------------------------------
create or replace function public.reports_to_me(sup_ids text[])
returns boolean
language sql
stable
as $$
  select public.current_member_id() = any(coalesce(sup_ids, '{}'::text[]));
$$;

revoke all on function public.reports_to_me(text[]) from public, anon;
grant execute on function public.reports_to_me(text[]) to authenticated;

------------------------------------------------------------------------
-- 4. A person can't be their own supervisor (any slot).
--    Replaces the scalar-only check from migration 014.
------------------------------------------------------------------------
alter table public.profiles
  drop constraint if exists profiles_not_self_supervisor;
alter table public.profiles
  add constraint profiles_not_self_supervisor
  check (member_id is null or not (member_id = any(supervisor_ids)));

------------------------------------------------------------------------
-- 5. Self-update freeze: a user edits their own name only, NOT their reporting
--    line. Recreated verbatim from migration 042 with supervisor_ids added.
------------------------------------------------------------------------
drop policy if exists "users update own profile name" on public.profiles;
create policy "users update own profile name" on public.profiles
for update to authenticated
using (auth.uid() = id)
with check (
  auth.uid() = id
  and role           = (select p.role           from public.profiles p where p.id = auth.uid())
  and approved       = (select p.approved       from public.profiles p where p.id = auth.uid())
  and supervisor_id  is not distinct from (select p.supervisor_id  from public.profiles p where p.id = auth.uid())
  and supervisor_ids is not distinct from (select p.supervisor_ids from public.profiles p where p.id = auth.uid())
  and company_ids    is not distinct from (select p.company_ids    from public.profiles p where p.id = auth.uid())
  and member_id      is not distinct from (select p.member_id      from public.profiles p where p.id = auth.uid())
  and email          is not distinct from (select p.email          from public.profiles p where p.id = auth.uid())
);

------------------------------------------------------------------------
-- 6. Re-issue the task policies that gate a supervisor to their reports.
--    Bodies are the POST-072 versions (is_shared_bucket), with:
--      - the supervisor subquery switched to reports_to_me(p.supervisor_ids)
--      - the watchers ? current_member_id() clause (migration 051) preserved
--        in the READ policy.
------------------------------------------------------------------------
drop policy if exists "role users can read tasks"   on public.tasks;
create policy "role users can read tasks" on public.tasks
for select to authenticated
using (
  public.current_profile_role() = 'developer'
  or (
    (company_id = any(public.current_company_ids()) or is_shared_bucket)
    and (
      public.current_profile_role() in ('admin', 'construction_supervisor', 'sales')
      or (
        public.current_profile_role() = 'supervisor'
        and (
          assignee_id = public.current_member_id()
          or creator_id = public.current_member_id()
          or watchers ? public.current_member_id()
          or exists (
            select 1 from public.profiles p
            where p.member_id = public.tasks.assignee_id
              and public.reports_to_me(p.supervisor_ids)
          )
        )
      )
      or (
        public.current_profile_role() = 'worker'
        and (
          assignee_id = public.current_member_id()
          or creator_id = public.current_member_id()
          or watchers ? public.current_member_id()
          or is_shared_bucket
        )
      )
    )
  )
);

drop policy if exists "role users can update tasks" on public.tasks;
create policy "role users can update tasks" on public.tasks
for update to authenticated
using (
  public.current_profile_role() = 'developer'
  or (
    (company_id = any(public.current_company_ids()) or is_shared_bucket)
    and (
      public.current_profile_role() in ('admin', 'construction_supervisor', 'sales')
      or (
        public.current_profile_role() = 'supervisor'
        and (
          assignee_id = public.current_member_id()
          or creator_id = public.current_member_id()
          or exists (
            select 1 from public.profiles p
            where p.member_id = public.tasks.assignee_id
              and public.reports_to_me(p.supervisor_ids)
          )
        )
      )
      or (
        public.current_profile_role() = 'worker'
        and (assignee_id = public.current_member_id() or is_shared_bucket)
      )
    )
  )
)
with check (
  public.current_profile_role() = 'developer'
  or (
    (company_id = any(public.current_company_ids()) or is_shared_bucket)
    and (
      public.current_profile_role() in ('admin', 'construction_supervisor', 'sales')
      or (
        public.current_profile_role() = 'supervisor'
        and (
          assignee_id = public.current_member_id()
          or creator_id = public.current_member_id()
          or exists (
            select 1 from public.profiles p
            where p.member_id = public.tasks.assignee_id
              and public.reports_to_me(p.supervisor_ids)
          )
        )
      )
      or (
        public.current_profile_role() = 'worker'
        and (
          assignee_id = public.current_member_id()
          or (
            creator_id = public.current_member_id()
            and public.assignee_in_company(assignee_id, company_id)
          )
          or is_shared_bucket
        )
      )
    )
  )
);

commit;

-- Verify: run supabase/sql/verify/073_check.sql on the SAME dev DB after applying.
