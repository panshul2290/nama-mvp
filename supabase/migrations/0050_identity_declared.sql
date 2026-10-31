-- 0050: identity numbers are declared by the person and verified by NWS staff only (security
-- review SEC-05).
--
-- verify_identity() marked any well-formed number as verified, so identity-gated orders and
-- anything relying on profiles.id_verified could be bypassed with a made-up number. Now:
--   * verify_identity() stores the number as DECLARED (profiles.id_status = 'declared',
--     id_verified false). Changing the number later drops a previous verification.
--   * Only NWS staff who may see the ID scans (admin, permit officer, inspector, 0049) mark it
--     verified or rejected — staff_customer_action('verify_id' | 'reject_id'), with a reason,
--     audited — and only once a number is declared. The person's identity documents are marked
--     accepted / rejected with it. id_verified_by / id_verified_at record who and when.
--   * Accounts "verified" by the old self-check are moved back to declared (they were never
--     checked by anyone).
-- Follow-up (documented): a national ID (ROP) integration; uniqueness of an ID number across
-- verified accounts on a keyed hash.

alter table public.profiles
  add column id_status      text not null default 'none' check (id_status in ('none', 'declared', 'verified', 'rejected')),
  add column id_verified_by uuid references public.profiles (id) on delete set null,
  add column id_verified_at timestamptz;
update public.profiles set id_status = case when id_type is not null then 'declared' else 'none' end, id_verified = false
 where id_verified or id_type is not null;
grant select (id_status, id_verified_at) on public.profiles to authenticated;

create or replace function public.my_private_profile()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object('id_type', id_type, 'id_no', id_no, 'id_verified', id_verified, 'id_status', id_status,
                            'prefs', prefs, 'loyalty_points', loyalty_points, 'email', email)
    from public.profiles where id = auth.uid()
$$;

-- Civil ID / resident card: 8 digits; passport: 5–20 letters and digits (upper-case, no spaces).
-- Stored as declared: NWS checks it.
create or replace function public.verify_identity(p_id_type text, p_id_no text)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare p public.profiles; b public.profiles; v text := upper(regexp_replace(coalesce(p_id_no, ''), '[\s-]', '', 'g'));
begin
  if auth.uid() is null then raise exception 'not_found'; end if;
  if p_id_type is null or p_id_type not in ('civil_id', 'resident_card', 'passport') then raise exception 'invalid_id_type'; end if;
  if p_id_type in ('civil_id', 'resident_card') and v !~ '^[0-9]{8}$' then raise exception 'id_not_verified'; end if;
  if p_id_type = 'passport' and v !~ '^[A-Z0-9]{5,20}$' then raise exception 'id_not_verified'; end if;
  select * into b from public.profiles where id = auth.uid() for update;
  -- The same number again keeps an NWS verification; a new one starts over.
  if b.id_verified and b.id_type = p_id_type and public.pii_decrypt(b.id_no_enc) = v then return b; end if;
  update public.profiles
     set id_type = p_id_type, id_no = v, id_verified = false, id_status = 'declared', id_verified_by = null, id_verified_at = null
   where id = auth.uid() returning * into p;
  return p;
end $$;

-- Staff actions on a customer: goodwill, block / unblock, and the identity check.
create or replace function public.staff_customer_action(p_customer_id uuid, p_action text, p_reason text, p_amount numeric default null)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare b public.profiles; a public.profiles; r text;
begin
  r := public.require_reason(p_reason);
  select * into b from public.profiles where id = p_customer_id and role in ('customer', 'business') for update;
  if not found then raise exception 'not_found'; end if;
  if p_action = 'goodwill' then
    perform public.require_staff(array['complaints_agent', 'finance', 'admin']::public.staff_role[]);
    if coalesce(p_amount, 0) <= 0 or p_amount > 50 then raise exception 'invalid_amount'; end if;
    insert into public.wallet_tx (customer_id, kind, amount, memo) values (b.id, 'goodwill', round(p_amount, 3), 'Goodwill credit: ' || r);
    a := b;
  elsif p_action in ('block', 'unblock') then
    perform public.require_staff(array['operator', 'admin']::public.staff_role[]);
    update public.profiles set account_blocked = (p_action = 'block') where id = b.id returning * into a;
  elsif p_action in ('verify_id', 'reject_id') then
    perform public.require_staff(array['permit_officer', 'inspector', 'admin']::public.staff_role[]);
    if b.id_type is null or b.id_status = 'none' then raise exception 'id_not_declared'; end if;
    update public.profiles
       set id_verified = (p_action = 'verify_id'), id_status = case when p_action = 'verify_id' then 'verified' else 'rejected' end,
           id_verified_by = auth.uid(), id_verified_at = now()
     where id = b.id returning * into a;
    update public.identity_documents
       set review_status = case when p_action = 'verify_id' then 'accepted' else 'rejected' end,
           review_note = left(r, 300), reviewed_by = auth.uid(), reviewed_at = now()
     where user_id = b.id and review_status = 'received';
  else raise exception 'invalid_action'; end if;
  perform public.write_audit('customer.' || p_action, 'profile', b.id::text,
    jsonb_build_object('account_blocked', b.account_blocked, 'id_verified', b.id_verified, 'id_status', b.id_status),
    jsonb_build_object('account_blocked', a.account_blocked, 'id_verified', a.id_verified, 'id_status', a.id_status, 'amount', p_amount), r);
  return a;
end $$;
