-- Run this in the Supabase SQL Editor after your core setup script
-- (supabase-setup.sql). This works whether or not you've set up
-- billing/profiles yet — it's independent of that.
--
-- This restricts sign-ups to only the email addresses you approve.

create table if not exists allowed_emails (
  email text primary key
);

-- Add the emails you want to allow. Edit this list to match who
-- should be able to sign up. You can add more people later too —
-- see the note at the bottom of this file.
insert into allowed_emails (email) values
  ('deifedaeton@gmail.com'),
  ('deifefamily@gmail.com')
on conflict (email) do nothing;

-- Reject sign-up attempts from anyone not on the list, before the
-- account is even created.
create or replace function public.check_email_allowed()
returns trigger as $$
begin
  if not exists (
    select 1 from public.allowed_emails
    where lower(email) = lower(new.email)
  ) then
    raise exception 'This email is not authorized to sign up for Grain Desk.';
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_email_check on auth.users;
create trigger on_auth_user_email_check
  before insert on auth.users
  for each row execute procedure public.check_email_allowed();

-- To approve someone new later: go to Table Editor > allowed_emails
-- in Supabase and add a row with their email. No code changes needed.
