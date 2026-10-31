-- 0046: demo login codes only for demo numbers (security review SEC-01).
--
-- With DEMO_SMS_CODES on, demo_sms_code(phone) used to return the latest code for ANY number to
-- anyone, signed in or not, so any account could be taken over by requesting a code and reading
-- it back. A code is now shown on screen only when the number:
--   * has no account yet (signing up with a new number), or
--   * belongs to a demo account (an @nama.test email: the seeded personas and test accounts), or
--   * is listed in DEMO_SMS_ALLOWLIST (comma-separated mobiles of named testers).
-- Every other account must receive its code by a real SMS/WhatsApp (or sign in with its password).

insert into public.app_settings (key, value, notes) values
  ('DEMO_SMS_ALLOWLIST', '', 'Comma-separated mobiles whose login codes may be shown on screen while DEMO_SMS_CODES is on (named testers). Demo (@nama.test) accounts and numbers without an account are always allowed.')
on conflict (key) do nothing;

create or replace function public.demo_sms_code(p_phone text)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  p text := public.normalize_phone(p_phone);
  v text;
  allowed boolean;
begin
  if coalesce((select value from public.app_settings where key = 'DEMO_SMS_CODES'), 'off') <> 'on' or p is null then return null; end if;
  allowed :=
    -- a named tester
    exists (
      select 1 from unnest(string_to_array(coalesce((select value from public.app_settings where key = 'DEMO_SMS_ALLOWLIST'), ''), ',')) as a(n)
      where public.normalize_phone(trim(a.n)) = p
    )
    -- or no account other than demo ones uses this number (auth phone or profile phone)
    or not exists (
      select 1
      from auth.users u
      left join public.profiles pr on pr.id = u.id
      where (public.normalize_phone(u.phone) = p or public.normalize_phone(pr.phone) = p)
        and coalesce(lower(u.email), '') not like '%@nama.test'
    );
  if not allowed then return null; end if;
  select otp into v from public.sms_outbox where phone = p and created_at > now() - interval '10 minutes' order by created_at desc, id desc limit 1;
  return v;
end $$;

revoke execute on function public.demo_sms_code(text) from public;
grant execute on function public.demo_sms_code(text) to anon, authenticated;
