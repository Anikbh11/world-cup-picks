create table if not exists public.bracket_states (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.bracket_submissions (
  id uuid primary key,
  player_name text not null,
  state jsonb not null,
  locked_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.bracket_states enable row level security;
alter table public.bracket_submissions enable row level security;

drop policy if exists "Public can read bracket states" on public.bracket_states;
create policy "Public can read bracket states"
on public.bracket_states
for select
to anon
using (true);

drop policy if exists "Public can write bracket states" on public.bracket_states;
create policy "Public can write bracket states"
on public.bracket_states
for insert
to anon
with check (true);

drop policy if exists "Public can update bracket states" on public.bracket_states;
create policy "Public can update bracket states"
on public.bracket_states
for update
to anon
using (true)
with check (true);

drop policy if exists "Public can read bracket submissions" on public.bracket_submissions;
create policy "Public can read bracket submissions"
on public.bracket_submissions
for select
to anon
using (true);

drop policy if exists "Public can insert bracket submissions" on public.bracket_submissions;
create policy "Public can insert bracket submissions"
on public.bracket_submissions
for insert
to anon
with check (true);

drop policy if exists "Public can update bracket submissions" on public.bracket_submissions;
revoke update on public.bracket_submissions from anon, authenticated;

create or replace function public.prevent_public_submission_updates()
returns trigger
language plpgsql
as $$
begin
  if current_setting('request.jwt.claim.role', true) in ('anon', 'authenticated') then
    raise exception 'Bracket submissions are locked once created.';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_public_submission_updates on public.bracket_submissions;
create trigger prevent_public_submission_updates
before update on public.bracket_submissions
for each row
execute function public.prevent_public_submission_updates();

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'bracket_states'
  ) then
    alter publication supabase_realtime add table public.bracket_states;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'bracket_submissions'
  ) then
    alter publication supabase_realtime add table public.bracket_submissions;
  end if;
end $$;
