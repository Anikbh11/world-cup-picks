drop policy if exists "Public can update bracket submissions"
on public.bracket_submissions;

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
