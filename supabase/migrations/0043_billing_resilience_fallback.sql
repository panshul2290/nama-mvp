-- Never block a delivery when billing is down; fallback to 1442 / WhatsApp (items 26, 27).
--
-- Review of every path where payment or billing state could stop dispatch, acceptance, fill,
-- delivery or proof of delivery (0012–0039):
--   * open_requests_near, dispatch_rank / auto-offer, accept_order, staff assignment, confirm_fill,
--     submit_pod, confirm_discharge, mark_delivered and settle_order never read payment_status:
--     a pending ("confirming") payment, a business order on account and an uninvoiced order all
--     dispatch and deliver. settle_order captures only authorised payments and leaves a pending
--     one pending; the company is paid its earning regardless.
--   * Invoicing (invoice_org) runs after delivery and never touches order status; a failed
--     invoice run leaves the orders uninvoiced (they still count against the credit limit, which
--     is a credit decision, not a billing outage).
--   * Checkout: an explicit card decline (simulated card 0002) still cancels the order: the
--     customer is there and chooses to retry. Insufficient wallet balance is refused up front.
--   * Household contract auto-pay (0015) authorised a saved card unconditionally; a declined
--     saved card now proceeds with the payment pending and a follow-up for NWS finance.
-- What changes:
--   * orders.payment_followup: why NWS finance has to follow the payment up (pay later during an
--     outage, a payment still pending after 10 minutes or at delivery, auto-pay failed), with
--     resolution; NWS → Settings → Payments lists them.
--   * PAYMENT_OUTAGE_MODE (off/on): during a gateway outage card payments are queued as
--     "pay later" (payment pending, ref PAYLATER-…) and the order proceeds; the customer is told.
--   * SUPPORT_CONTACTS: the call centre (1442), the Nama WhatsApp booking number, the public web
--     address used for shared links, and the minutes without a tanker before the apps offer the
--     fallback card.

-- ===========================================================================
-- Settings
-- ===========================================================================
insert into public.app_settings (key, value, notes) values
  ('PAYMENT_OUTAGE_MODE', 'off',
   'on during a payment gateway outage: card payments are queued as "pay later" (the order proceeds; NWS finance follows up). off = normal.'),
  ('SUPPORT_CONTACTS', '{"call_centre": "1442", "whatsapp": "", "public_url": "", "no_tanker_min": 20}',
   'Fallback contacts shown when the app can''t place an order: call_centre (dialled as is), whatsapp (E.164; empty hides "Book on WhatsApp"), public_url (https base for shared links; empty = the site''s own address), no_tanker_min (minutes without a tanker before the fallback card shows).')
on conflict (key) do nothing;
alter table public.app_settings add constraint app_settings_payment_outage_mode check (key <> 'PAYMENT_OUTAGE_MODE' or value in ('on', 'off'));

create function public.payment_outage_on()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce((select value from public.app_settings where key = 'PAYMENT_OUTAGE_MODE'), 'off') = 'on' $$;

create function public.staff_set_payment_outage(p_on boolean, p_reason text)
returns text
language plpgsql security definer set search_path = public
as $$
declare b text; a text := case when coalesce(p_on, false) then 'on' else 'off' end; r text;
begin
  perform public.require_staff(array['finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select value into b from public.app_settings where key = 'PAYMENT_OUTAGE_MODE' for update;
  update public.app_settings set value = a where key = 'PAYMENT_OUTAGE_MODE';
  perform public.write_audit('setting.update', 'setting', 'PAYMENT_OUTAGE_MODE', to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

create function public.staff_set_support_contacts(p_value jsonb, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare b jsonb; r text; v jsonb := coalesce(p_value, '{}'::jsonb); call text; wa text; url text; mins integer;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  call := regexp_replace(coalesce(v ->> 'call_centre', ''), '[\s-]', '', 'g');
  if call !~ '^\+?[0-9]{3,15}$' then raise exception 'invalid_value: call centre number'; end if;
  wa := nullif(btrim(coalesce(v ->> 'whatsapp', '')), '');
  if wa is not null then
    wa := public.normalize_phone(wa);
    if wa is null then raise exception 'invalid_phone'; end if;
  end if;
  url := rtrim(btrim(coalesce(v ->> 'public_url', '')), '/');
  if url <> '' and url !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$' then raise exception 'invalid_value: public address must start with https://'; end if;
  mins := coalesce((v ->> 'no_tanker_min')::integer, 20);
  if mins not between 5 and 240 then raise exception 'invalid_value: minutes must be 5–240'; end if;
  v := jsonb_build_object('call_centre', call, 'whatsapp', coalesce(wa, ''), 'public_url', url, 'no_tanker_min', mins);
  b := public.setting_json('SUPPORT_CONTACTS');
  update public.app_settings set value = v::text where key = 'SUPPORT_CONTACTS';
  perform public.write_audit('setting.update', 'setting', 'SUPPORT_CONTACTS', b, v, r);
  return v;
end $$;

-- ===========================================================================
-- Payment follow-ups on orders
-- ===========================================================================
alter table public.orders
  add column payment_followup             text check (payment_followup in ('outage_pay_later', 'payment_pending', 'autopay_failed')),
  add column payment_followup_at          timestamptz,
  add column payment_followup_resolved_at timestamptz,
  add column payment_followup_resolved_by uuid references public.profiles (id) on delete set null,
  add column payment_followup_note        text check (char_length(payment_followup_note) <= 300);
create index orders_payment_followup_open_idx on public.orders (payment_followup_at desc)
  where payment_followup is not null and payment_followup_resolved_at is null;

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('pay_later', 'Card payment queued (gateway outage)', 'customer', '{order} is going ahead',
   'Card payments are temporarily unavailable. Your order is going ahead and you''ll be asked to pay {total} OMR later. Nothing has been charged to your card.',
   'طلبك {order} مستمر',
   'الدفع بالبطاقة غير متاح مؤقتاً. طلبك مستمر وسيُطلب منك دفع {total} ر.ع. لاحقاً. لم يُخصم أي مبلغ من بطاقتك.',
   true, true, false, false, 'service', true),
  ('autopay_failed', 'Contract auto-pay failed', 'customer', 'Payment for {order} didn''t go through',
   'We couldn''t charge your saved card for {order} ({slot}). The delivery goes ahead; NWS will contact you about the payment, or update your card in Wallet.',
   'لم يتم الدفع للطلب {order}',
   'تعذّر الخصم من بطاقتك المحفوظة للطلب {order} ({slot}). سيتم التوصيل كالمعتاد، وسيتواصل معك فريق نماء بشأن الدفع، أو حدّث بطاقتك من المحفظة.',
   true, true, false, false, 'service', true)
on conflict (event) do nothing;

-- Checkout (0036's wrapper) plus pay-later during an outage. The core still debits the wallet
-- part; the card part is recorded as a pending payment instead of being sent to the gateway, so
-- no decline can happen, and finance follows it up.
create or replace function public.create_order(
  p_service_type public.service_type,
  p_gallons      integer,
  p_lat          double precision,
  p_lng          double precision,
  p_area         text,
  p_address      text default '',
  p_property_id  uuid default null,
  p_slot_start   timestamptz default null,
  p_slot_end     timestamptz default null,
  p_slot_label   text default null,
  p_emergency    boolean default false,
  p_driver_note  text default null,
  p_pay_method   text default 'card',
  p_card_last4   text default null,
  p_promo_code   text default null
)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; later boolean := public.payment_outage_on() and coalesce(p_pay_method, '') in ('card', 'omannet', 'wallet_card');
begin
  perform set_config('nama.pricing_point', case when p_lat is not null and p_lng is not null then p_lat::text || ',' || p_lng::text else '' end, true);
  o := public.create_order_core(p_service_type, p_gallons, p_lat, p_lng, p_area, p_address, p_property_id, p_slot_start, p_slot_end,
                                p_slot_label, p_emergency, p_driver_note, p_pay_method, case when later then null else p_card_last4 end, p_promo_code);
  perform set_config('nama.pricing_point', '', true);
  update public.payments set confirmed_at = now() where order_id = o.id and status = 'authorized' and confirmed_at is null;
  if later and o.payment_status = 'authorized' then
    update public.payments
       set status = 'pending', confirmed_at = null, gateway_ref = 'PAYLATER-' || o.order_no,
           card_last4 = case when p_card_last4 ~ '^[0-9]{4}$' then p_card_last4 else card_last4 end
     where order_id = o.id and status = 'authorized' and card_amount > 0;
    if found then
      update public.orders set payment_status = 'pending', payment_followup = 'outage_pay_later', payment_followup_at = now()
       where id = o.id returning * into o;
      perform public.notify(o.customer_id, 'pay_later', o.id, jsonb_build_object('order', 'TO-' || o.order_no, 'total', to_char(o.total, 'FM9990.000')));
    end if;
  elsif coalesce(p_card_last4, '') = '0003' and o.payment_status = 'authorized' then
    update public.payments set status = 'pending', confirmed_at = null where order_id = o.id and status = 'authorized' and card_amount > 0;
    if found then
      update public.orders set payment_status = 'pending' where id = o.id returning * into o;
    end if;
  end if;
  return o;
end $$;

-- A delivery made while its payment is still pending is flagged for finance (it went ahead).
create function public.orders_payment_followup_flag()
returns trigger
language plpgsql
as $$
begin
  if new.payment_status = 'pending' and new.payment_followup is null then
    new.payment_followup := 'payment_pending';
    new.payment_followup_at := now();
  end if;
  return new;
end $$;
create trigger orders_payment_followup_flag before update of status on public.orders
  for each row when (new.status = 'delivered' and old.status is distinct from 'delivered') execute function public.orders_payment_followup_flag();

-- A pay-later or failed auto-pay order cancelled before anyone paid: the wallet part goes back
-- and the follow-up closes (the card was never charged).
create function public.orders_paylater_cancel()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare p public.payments;
begin
  for p in select * from public.payments where order_id = new.id and status = 'pending'
              and (coalesce(gateway_ref, '') like 'PAYLATER-%' or coalesce(gateway_ref, '') like 'AUTOPAY-%') for update loop
    if p.wallet_amount > 0 and p.customer_id is not null then
      perform public.lock_wallet(p.customer_id);
      insert into public.wallet_tx (customer_id, kind, amount, order_id, memo) values (p.customer_id, 'refund', p.wallet_amount, new.id, 'Cancelled TO-' || new.order_no || ' (wallet part)');
    end if;
    update public.payments set status = 'failed', failure_reason = 'Order cancelled before payment' where id = p.id;
  end loop;
  if found then
    update public.orders set payment_status = 'failed',
                             payment_followup_resolved_at = coalesce(payment_followup_resolved_at, now()),
                             payment_followup_note = coalesce(payment_followup_note, 'Order cancelled before payment')
     where id = new.id;
  end if;
  return new;
end $$;
create trigger orders_paylater_cancel after update of status on public.orders
  for each row when (new.status = 'cancelled' and old.status is distinct from 'cancelled') execute function public.orders_paylater_cancel();

-- pg_cron, every 5 minutes: payments still pending after 10 minutes are flagged; follow-ups
-- whose payment has since been confirmed close by themselves.
create function public.scan_payment_followups()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare flagged integer; closed integer;
begin
  if auth.uid() is not null then perform public.require_staff(array['finance']::public.staff_role[]); end if;
  update public.orders set payment_followup = 'payment_pending', payment_followup_at = now()
   where payment_status = 'pending' and payment_followup is null and status <> 'cancelled' and created_at < now() - interval '10 minutes';
  get diagnostics flagged = row_count;
  update public.orders set payment_followup_resolved_at = now(), payment_followup_note = coalesce(payment_followup_note, 'Payment confirmed')
   where payment_followup is not null and payment_followup_resolved_at is null and payment_status in ('authorized', 'captured');
  get diagnostics closed = row_count;
  return jsonb_build_object('flagged', flagged, 'closed', closed);
end $$;

-- NWS finance: the follow-ups (open, resolved or all).
create function public.staff_payment_followups(p_state text default 'open', p_limit integer default 200)
returns table (order_id uuid, order_no bigint, status public.order_status, is_test boolean, customer_name text, org_name text, total numeric,
               pay_method text, payment_status text, reason text, flagged_at timestamptz, delivered_at timestamptz,
               resolved_at timestamptz, note text, gateway_ref text)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_staff(array['finance', 'operator']::public.staff_role[]);
  return query
    select o.id, o.order_no, o.status, o.is_test, p.full_name, g.name, o.total, o.pay_method, o.payment_status, o.payment_followup,
           o.payment_followup_at, o.delivered_at, o.payment_followup_resolved_at, o.payment_followup_note,
           (select y.gateway_ref from public.payments y where y.order_id = o.id order by y.created_at desc limit 1)
      from public.orders o
      left join public.profiles p on p.id = o.customer_id
      left join public.organizations g on g.id = o.org_id
     where o.payment_followup is not null
       and (coalesce(p_state, 'open') = 'all'
            or (p_state = 'open' and o.payment_followup_resolved_at is null)
            or (p_state = 'resolved' and o.payment_followup_resolved_at is not null))
     order by o.payment_followup_resolved_at is null desc, o.payment_followup_at desc
     limit greatest(least(coalesce(p_limit, 200), 1000), 1);
end $$;

-- Finance closes a follow-up: 'paid' (collected: the pending payment is confirmed) or 'waived'
-- (written off, with a reason). Audited.
create function public.staff_resolve_payment_followup(p_order uuid, p_action text, p_note text)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare b public.orders; a public.orders; r text;
begin
  perform public.require_staff(array['finance']::public.staff_role[]);
  if p_action not in ('paid', 'waived') then raise exception 'invalid_action'; end if;
  r := public.require_reason(p_note);
  select * into b from public.orders where id = p_order for update;
  if not found or b.payment_followup is null then raise exception 'not_found'; end if;
  if b.payment_followup_resolved_at is not null then raise exception 'invalid_state: already resolved'; end if;
  if p_action = 'paid' then
    update public.payments
       set status = case when b.status = 'delivered' then 'captured' else 'authorized' end, confirmed_at = now(),
           captured_at = case when b.status = 'delivered' then now() else captured_at end
     where order_id = b.id and status = 'pending';
    update public.orders set payment_status = case when b.status = 'delivered' then 'captured' else 'authorized' end
     where id = b.id and payment_status = 'pending';
  else
    update public.payments set status = 'failed', failure_reason = left('Waived by NWS finance: ' || r, 300) where order_id = b.id and status = 'pending';
    update public.orders set payment_status = 'failed' where id = b.id and payment_status = 'pending';
  end if;
  update public.orders set payment_followup_resolved_at = now(), payment_followup_resolved_by = auth.uid(), payment_followup_note = left(r, 300)
   where id = b.id returning * into a;
  perform public.write_audit('order.payment_followup_' || p_action, 'order', b.id::text,
    jsonb_build_object('payment_status', b.payment_status, 'followup', b.payment_followup),
    jsonb_build_object('payment_status', a.payment_status, 'resolved_at', a.payment_followup_resolved_at), r);
  return a;
end $$;

-- ===========================================================================
-- Household contract auto-pay (0015) with a declined saved card: the delivery goes ahead.
-- Simulated gateway: a saved card ending 0002 is declined; without a saved card the default
-- simulated card is used as before.
-- ===========================================================================
create or replace function public.generate_contract_orders(p_contract uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare c record; d date; n integer := 0; step interval; s timestamptz; o public.orders; who uuid; org public.organizations; q record; card4 text;
begin
  for c in select k.*, p.lat, p.lng, p.area, p.address from public.contracts k join public.properties p on p.id = k.property_id
            where k.status = 'active' and k.end_date >= current_date and (p_contract is null or k.id = p_contract) loop
    perform pg_advisory_xact_lock(hashtext('nama.contract:' || c.id::text));
    who := coalesce(c.customer_id, (select id from public.profiles where org_id = c.org_id and org_role = 'admin' order by created_at limit 1));
    if who is null then continue; end if;
    if c.org_id is not null then
      select * into org from public.organizations where id = c.org_id for update;
      if org.status <> 'active' or org.paused then continue; end if;
    end if;
    step := case c.frequency when 'weekly' then interval '7 days' when 'biweekly' then interval '14 days' else interval '1 month' end;
    d := c.start_date;
    while d < current_date loop d := (d + step)::date; end loop;
    while d <= current_date + 7 and d < c.end_date loop
      s := (d + case c.slot when 'evening' then time '18:00' else time '08:00' end) at time zone 'Asia/Muscat';
      if s > now() and not exists (select 1 from public.orders where contract_id = c.id and slot_start = s and status <> 'cancelled') then
        if c.org_id is not null then
          select * into q from public.price_quote_ext(c.service_type, c.gallons, c.slot = 'evening', false,
                                                      public.rule_num(case c.plan when 'yearly' then 'discount_yearly' else 'discount_monthly' end));
          if public.org_outstanding(c.org_id) + q.total > org.credit_limit then exit; end if;
        end if;
        begin
          insert into public.orders (customer_id, org_id, service_type, gallons, area, property_id, contract_id, zone_id, status, slot_start, slot_end, slot_label,
                                     slot_peak, channel, billing, pay_method, payment_status)
          values (who, c.org_id, c.service_type, c.gallons, coalesce(nullif(c.area, ''), 'Contract delivery'), c.property_id, c.id,
                  (public.zone_at(c.lat, c.lng, true)).id, 'scheduled', s, s + interval '2 hours',
                  to_char(d, 'Dy DD Mon') || case c.slot when 'evening' then ' · 6–8 pm' else ' · 8–10 am' end,
                  c.slot = 'evening', 'contract',
                  case when c.org_id is null then 'prepaid' else 'account' end,
                  case when c.org_id is null then 'card' else 'account' end,
                  case when c.org_id is null then 'authorized' else 'on_account' end)
          returning * into o;
        exception when unique_violation then
          d := (d + step)::date;
          continue;
        end;
        insert into public.order_locations (order_id, lat, lng, address) values (o.id, c.lat, c.lng, coalesce(c.address, ''));
        if c.org_id is null then
          card4 := coalesce((select last4 from public.payment_methods where customer_id = who and is_default limit 1), '4417');
          if card4 = '0002' or public.payment_outage_on() then
            insert into public.payments (order_id, customer_id, method, amount, card_amount, card_last4, status, gateway_ref, failure_reason)
            values (o.id, who, 'card', o.total, o.total, card4, 'pending', 'AUTOPAY-' || c.contract_no || '-' || o.order_no,
                    case when card4 = '0002' then 'Saved card declined (simulated)' else 'Payment gateway outage' end);
            update public.orders set payment_status = 'pending', payment_followup_at = now(),
                                     payment_followup = case when card4 = '0002' then 'autopay_failed' else 'outage_pay_later' end
             where id = o.id returning * into o;
            perform public.notify(who, 'autopay_failed', o.id, jsonb_build_object('order', 'TO-' || o.order_no, 'slot', coalesce(o.slot_label, '')));
          else
            insert into public.payments (order_id, customer_id, method, amount, card_amount, card_last4, status, gateway_ref)
            values (o.id, who, 'card', o.total, o.total, card4, 'authorized', 'CT-' || c.contract_no || '-' || o.order_no);
          end if;
        else
          insert into public.payments (order_id, org_id, customer_id, method, amount, status) values (o.id, c.org_id, who, 'account', o.total, 'on_account');
        end if;
        n := n + 1;
      end if;
      d := (d + step)::date;
    end loop;
  end loop;
  return n;
end $$;

select public.nama_schedule('nama-payment-followups', '*/5 * * * *', 'select public.scan_payment_followups()');

revoke execute on function public.orders_payment_followup_flag(), public.orders_paylater_cancel() from public, anon, authenticated;
revoke execute on function public.payment_outage_on(), public.staff_set_payment_outage(boolean, text), public.staff_set_support_contacts(jsonb, text),
  public.scan_payment_followups(), public.staff_payment_followups(text, integer), public.staff_resolve_payment_followup(uuid, text, text)
from public, anon;
grant execute on function public.payment_outage_on(), public.staff_set_payment_outage(boolean, text), public.staff_set_support_contacts(jsonb, text),
  public.scan_payment_followups(), public.staff_payment_followups(text, integer), public.staff_resolve_payment_followup(uuid, text, text)
to authenticated;
