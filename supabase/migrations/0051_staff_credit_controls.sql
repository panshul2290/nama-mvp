-- 0051: limits and a second approver for staff wallet credits (security review SEC-08).
--
-- Complaints agents, operators and finance could credit any wallet 50 OMR per call, as often as
-- they liked (goodwill, complaint refunds, manual order refunds). Now every discretionary staff
-- credit to a wallet — goodwill, a complaint refund (including its goodwill fallback) or a
-- manual "NWS refund" of an order — goes through one check, a trigger on wallet_tx, whatever
-- RPC wrote it:
--   * STAFF_CREDIT_LIMITS.second_approval_above_omr (default 20): a larger credit is refused
--     with second_approval_required; the staff member files it with staff_request_credit and a
--     DIFFERENT staff member with the finance role (or an admin) approves or rejects it
--     (staff_decide_credit). Approval runs the credit; both steps are audited.
--   * STAFF_CREDIT_LIMITS.per_staff_daily_omr (default 100): what one staff member credits in
--     any 24 hours, approved credits excepted (they had a second person).
-- Refunds of a cancelled order (the money the customer paid) and finance price corrections are
-- not discretionary and are not limited; card refunds never touch the wallet (0047).

insert into public.app_settings (key, value, notes) values
  ('STAFF_CREDIT_LIMITS', '{"second_approval_above_omr": 20, "per_staff_daily_omr": 100, "max_request_omr": 200}',
   'Staff wallet credits (goodwill, complaint refunds, manual order refunds): above second_approval_above_omr a second staff member (finance or admin) must approve; per_staff_daily_omr caps what one staff member credits in 24 hours; max_request_omr caps one approved credit.')
on conflict (key) do nothing;

create function public.staff_credit_limit(p_key text, p_default numeric)
returns numeric language sql stable security definer set search_path = public
as $$ select coalesce((public.setting_json('STAFF_CREDIT_LIMITS') ->> p_key)::numeric, p_default) $$;

alter table public.wallet_tx
  add column created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  add column credit_request_id uuid;
create index wallet_tx_created_by_idx on public.wallet_tx (created_by, created_at desc) where created_by is not null;

-- Pending / decided requests.
create sequence public.staff_credit_requests_no_seq as bigint start with 301;
create table public.staff_credit_requests (
  id            uuid primary key default gen_random_uuid(),
  request_no    bigint not null unique default nextval('public.staff_credit_requests_no_seq'),
  kind          text not null check (kind in ('goodwill', 'complaint_refund', 'order_refund')),
  customer_id   uuid not null references public.profiles (id) on delete cascade,
  order_id      uuid references public.orders (id) on delete set null,
  complaint_id  uuid references public.complaints (id) on delete set null,
  amount        numeric(10,3) not null check (amount > 0),
  reason        text not null check (char_length(reason) between 3 and 500),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by  uuid not null references public.profiles (id) on delete set null,
  decided_by    uuid references public.profiles (id) on delete set null,
  decided_at    timestamptz,
  decision_note text check (char_length(decision_note) <= 500),
  credited      numeric(10,3),
  created_at    timestamptz not null default now()
);
create index staff_credit_requests_pending_idx on public.staff_credit_requests (created_at) where status = 'pending';
alter table public.staff_credit_requests enable row level security;
revoke all on public.staff_credit_requests from public, anon, authenticated;
revoke all on sequence public.staff_credit_requests_no_seq from public, anon, authenticated;
grant select on public.staff_credit_requests to authenticated;
create policy staff_credit_requests_read on public.staff_credit_requests for select to authenticated
  using (public.my_staff_role() in ('admin', 'finance', 'complaints_agent', 'operator'));

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('credit_approval', 'Staff credit waiting for approval', 'staff', 'Credit CR-{no} needs your approval',
   '{who} asks to credit {amount} OMR ({kind}): {reason}. Approve or reject it in Settings → Payments.',
   'الرصيد CR-{no} يحتاج موافقتك',
   'يطلب {who} إضافة {amount} ر.ع. ({kind}): {reason}. وافق أو ارفض من الإعدادات ← المدفوعات.',
   true, false, false, false, 'service', false)
on conflict (event) do nothing;

-- Which wallet lines are discretionary staff credits.
create function public.is_staff_discretionary_credit(p_kind text, p_memo text)
returns boolean language sql immutable
as $$
  select p_kind = 'goodwill' or (p_kind = 'refund' and (coalesce(p_memo, '') like 'Complaint C-%' or coalesce(p_memo, '') like 'NWS refund TO-%'))
$$;

create function public.wallet_tx_staff_credit_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare approved text := nullif(current_setting('nama.credit_approved', true), ''); day_total numeric;
begin
  if new.amount <= 0 or auth.uid() is null or not public.is_staff() or not public.is_staff_discretionary_credit(new.kind, new.memo) then
    return new;
  end if;
  -- Run by staff_decide_credit for an approved request (the flag names that request).
  if approved is not null and exists (
       select 1 from public.staff_credit_requests r
        where r.id::text = approved and r.status = 'approved' and r.decided_by = auth.uid() and r.customer_id = new.customer_id) then
    new.credit_request_id := approved::uuid;
    return new;
  end if;
  if new.amount > public.staff_credit_limit('second_approval_above_omr', 20) then
    raise exception 'second_approval_required: credits above % OMR need a second staff member (finance or admin)',
      to_char(public.staff_credit_limit('second_approval_above_omr', 20), 'FM9990.000');
  end if;
  select coalesce(sum(w.amount), 0) into day_total from public.wallet_tx w
   where w.created_by = auth.uid() and w.created_at > now() - interval '24 hours' and w.amount > 0
     and w.credit_request_id is null and public.is_staff_discretionary_credit(w.kind, w.memo);
  if day_total + new.amount > public.staff_credit_limit('per_staff_daily_omr', 100) then
    raise exception 'staff_daily_credit_cap: % OMR a day per staff member', to_char(public.staff_credit_limit('per_staff_daily_omr', 100), 'FM9990');
  end if;
  return new;
end $$;
create trigger wallet_tx_staff_credit_guard before insert on public.wallet_tx
  for each row execute function public.wallet_tx_staff_credit_guard();

-- File a credit for a second approver.
create function public.staff_request_credit(p_kind text, p_customer uuid, p_amount numeric, p_reason text,
                                            p_complaint uuid default null, p_order uuid default null)
returns public.staff_credit_requests
language plpgsql security definer set search_path = public
as $$
declare q public.staff_credit_requests; r text; amt numeric := round(coalesce(p_amount, 0), 3); u record; who text; c public.complaints;
begin
  perform public.require_staff(array['complaints_agent', 'operator', 'finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if p_kind not in ('goodwill', 'complaint_refund', 'order_refund') then raise exception 'invalid_action'; end if;
  if amt <= 0 or amt > public.staff_credit_limit('max_request_omr', 200) then raise exception 'invalid_amount'; end if;
  if p_kind = 'complaint_refund' then
    select * into c from public.complaints where id = p_complaint;
    if not found or c.customer_id is null then raise exception 'not_found'; end if;
  elsif p_kind = 'order_refund' and not exists (select 1 from public.orders where id = p_order and customer_id = p_customer) then
    raise exception 'not_found';
  end if;
  if not exists (select 1 from public.profiles where id = coalesce(c.customer_id, p_customer) and role in ('customer', 'business')) then raise exception 'not_found'; end if;
  insert into public.staff_credit_requests (kind, customer_id, order_id, complaint_id, amount, reason, requested_by)
  values (p_kind, coalesce(c.customer_id, p_customer), coalesce(c.order_id, p_order), p_complaint, amt, left(r, 500), auth.uid())
  returning * into q;
  perform public.write_audit('credit.request', 'staff_credit_request', q.id::text, null,
    jsonb_build_object('kind', q.kind, 'customer_id', q.customer_id, 'amount', q.amount, 'order_id', q.order_id, 'complaint_id', q.complaint_id), r);
  who := coalesce((select full_name from public.profiles where id = auth.uid()), 'A staff member');
  for u in select id from public.profiles where role = 'nws_staff' and staff_role in ('finance', 'admin') and id <> auth.uid() order by staff_role, id limit 20 loop
    perform public.notify(u.id, 'credit_approval', q.order_id, jsonb_build_object('no', q.request_no, 'who', who, 'amount', to_char(q.amount, 'FM9990.000'),
                                                                               'kind', replace(q.kind, '_', ' '), 'reason', left(r, 120)));
  end loop;
  return q;
end $$;

-- The second staff member decides; an approval credits the wallet (refund first for refunds).
create function public.staff_decide_credit(p_request uuid, p_approve boolean, p_reason text)
returns public.staff_credit_requests
language plpgsql security definer set search_path = public
as $$
declare q public.staff_credit_requests; r text; done numeric := 0; c public.complaints; o public.orders;
begin
  perform public.require_staff(array['finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into q from public.staff_credit_requests where id = p_request for update;
  if not found then raise exception 'not_found'; end if;
  if q.status <> 'pending' then raise exception 'invalid_state'; end if;
  if q.requested_by = auth.uid() then raise exception 'same_approver: a second staff member must approve'; end if;
  if not p_approve then
    update public.staff_credit_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = left(r, 500)
     where id = q.id returning * into q;
    perform public.write_audit('credit.reject', 'staff_credit_request', q.id::text, jsonb_build_object('status', 'pending'), jsonb_build_object('status', q.status), r);
    return q;
  end if;
  update public.staff_credit_requests set status = 'approved', decided_by = auth.uid(), decided_at = now(), decision_note = left(r, 500)
   where id = q.id returning * into q;
  perform set_config('nama.credit_approved', q.id::text, true);
  if q.kind = 'goodwill' then
    insert into public.wallet_tx (customer_id, kind, amount, memo) values (q.customer_id, 'goodwill', q.amount, 'Goodwill credit CR-' || q.request_no || ': ' || left(q.reason, 200));
    done := q.amount;
  elsif q.kind = 'complaint_refund' then
    select * into c from public.complaints where id = q.complaint_id for update;
    if c.order_id is not null then done := public.refund_to_wallet(c.order_id, q.amount, 'refund', 'Complaint C-' || c.case_no); end if;
    if coalesce(done, 0) = 0 then
      insert into public.wallet_tx (customer_id, kind, amount, order_id, memo) values (q.customer_id, 'goodwill', q.amount, c.order_id, 'Complaint C-' || c.case_no);
      done := q.amount;
    end if;
    update public.complaints set refund_amount = refund_amount + done where id = c.id;
    insert into public.complaint_notes (complaint_id, author_id, author_role, body)
    values (c.id, auth.uid(), 'staff', 'Refunded ' || to_char(done, 'FM9990.000') || ' OMR (approved credit CR-' || q.request_no || ').');
  else
    select * into o from public.orders where id = q.order_id;
    done := public.refund_to_wallet(o.id, q.amount, 'refund', 'NWS refund TO-' || o.order_no || ': ' || left(q.reason, 200));
    if coalesce(done, 0) = 0 then raise exception 'nothing_to_refund'; end if;
  end if;
  perform set_config('nama.credit_approved', '', true);
  update public.staff_credit_requests set credited = done where id = q.id returning * into q;
  perform public.write_audit('credit.approve', 'staff_credit_request', q.id::text, jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', q.status, 'credited', done, 'requested_by', q.requested_by), r);
  return q;
end $$;

revoke execute on function public.wallet_tx_staff_credit_guard(), public.staff_credit_limit(text, numeric) from public, anon, authenticated;
revoke execute on function public.is_staff_discretionary_credit(text, text) from public, anon;
revoke execute on function public.staff_request_credit(text, uuid, numeric, text, uuid, uuid), public.staff_decide_credit(uuid, boolean, text) from public, anon;
grant execute on function public.staff_request_credit(text, uuid, numeric, text, uuid, uuid), public.staff_decide_credit(uuid, boolean, text) to authenticated;
