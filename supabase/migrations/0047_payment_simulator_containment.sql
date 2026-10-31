-- 0047: contain the simulated payment gateway (security review SEC-02).
--
-- The demo has no payment gateway: wallet top-ups and card payments were "approved" inside the
-- database from what the app sent (card ending 0002 declines, 0003 answers later), cancelling a
-- card order put the money into the wallet, and a card tip became company earnings at once. That
-- was a money path anyone could drive. Now:
--
--   * PAYMENT_SIMULATOR (app_settings, JSON) switches the simulation on or off:
--       {"mode": "on", "daily_topup_omr": 50, "wallet_cap_omr": 150}
--     It is ON for the demo (this migration) and must be OFF in production. When the setting is
--     missing or anything but "on", the simulator is off.
--   * Simulator ON (demo): the flows work as before (0002 declines, 0003 is confirmed by pg_cron
--     after ~20 s), but a customer can top up at most daily_topup_omr per 24 hours and only while
--     the wallet (plus pending top-ups) stays at or below wallet_cap_omr.
--   * Simulator OFF (the real-gateway path inherits none of the shortcuts): no magic card numbers;
--     every card/OmanNet amount is recorded as PENDING with a PSP-… reference (a trigger on
--     payments enforces it for every path: checkout, contract auto-pay, tips); top-ups stay
--     pending and are never credited; confirm_simulated_payments does nothing. Only
--     gateway_confirm() — executable by the service role only, i.e. a server-side webhook
--     route that has verified the PSP's signature — confirms or fails a PSP payment, top-up
--     or refund, idempotently, and only for the exact amount.
--   * Refunds go back the way the customer paid: the wallet part to the wallet (instant), the
--     card part as a card_refunds record to the same card (completed at once by the simulator,
--     pending for the gateway otherwise) — never as wallet credit.
--   * Tips: company earnings only from a confirmed payment (a wallet tip, a simulated card tip,
--     or a gateway-confirmed one). Order refunds never touch a tip payment (payments.kind).

-- ===========================================================================
-- Setting and helpers
-- ===========================================================================
insert into public.app_settings (key, value, notes) values
  ('PAYMENT_SIMULATOR', '{"mode": "on", "daily_topup_omr": 50, "wallet_cap_omr": 150}',
   'Demo payment simulator. mode on: card payments and top-ups are simulated (card 0002 declines, 0003 confirms after ~20 s), top-ups capped per customer per 24 h (daily_topup_omr) and by wallet balance (wallet_cap_omr). mode off (PRODUCTION): every card amount waits for a verified gateway confirmation (gateway_confirm). Change as the database owner only.')
on conflict (key) do nothing;
alter table public.app_settings add constraint app_settings_payment_simulator check (
  key <> 'PAYMENT_SIMULATOR' or (value ~ '^\s*\{' and (value::jsonb ->> 'mode') in ('on', 'off')));

create function public.payment_simulator_on()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce((select value::jsonb ->> 'mode' from public.app_settings where key = 'PAYMENT_SIMULATOR'), 'off') = 'on' $$;

create function public.payment_simulator_num(p_key text, p_default numeric)
returns numeric language sql stable security definer set search_path = public
as $$ select coalesce((select (value::jsonb ->> p_key)::numeric from public.app_settings where key = 'PAYMENT_SIMULATOR'), p_default) $$;

-- ===========================================================================
-- Payments: purpose, card refunds, and no unconfirmed card money without the simulator
-- ===========================================================================
alter table public.payments
  add column kind text not null default 'order' check (kind in ('order', 'tip')),
  add column refunded_to_card numeric(10,3) not null default 0 check (refunded_to_card >= 0);
update public.payments set kind = 'tip' where gateway_ref like 'TIP-%';
create index payments_gateway_ref_idx on public.payments (gateway_ref) where gateway_ref is not null;

create sequence public.card_refunds_no_seq as bigint start with 7001;
create table public.card_refunds (
  id           uuid primary key default gen_random_uuid(),
  refund_no    bigint not null unique default nextval('public.card_refunds_no_seq'),
  payment_id   uuid not null references public.payments (id) on delete cascade,
  order_id     uuid references public.orders (id) on delete set null,
  customer_id  uuid references public.profiles (id) on delete set null,
  amount       numeric(10,3) not null check (amount > 0),
  card_last4   text,
  status       text not null check (status in ('pending', 'completed', 'failed')),
  gateway_ref  text not null,
  memo         text not null default '',
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index card_refunds_order_idx on public.card_refunds (order_id);
create index card_refunds_customer_idx on public.card_refunds (customer_id, created_at desc);
alter table public.card_refunds enable row level security;
revoke all on public.card_refunds from public, anon, authenticated;
revoke all on sequence public.card_refunds_no_seq from public, anon, authenticated;
grant select on public.card_refunds to authenticated;
create policy card_refunds_read on public.card_refunds for select to authenticated
  using (customer_id = auth.uid() or public.my_staff_role() in ('admin', 'finance', 'complaints_agent', 'operator'));

-- Every card/OmanNet amount recorded as approved while the simulator is off waits for the
-- gateway instead (status pending, PSP-… reference). This catches every path at once.
create function public.payments_require_gateway()
returns trigger
language plpgsql
as $$
begin
  if new.card_amount > 0 and new.status in ('authorized', 'captured') and not public.payment_simulator_on() then
    new.status := 'pending';
    new.confirmed_at := null;
    new.captured_at := null;
    new.gateway_ref := 'PSP-' || coalesce(nullif(new.gateway_ref, ''), new.id::text);
  end if;
  return new;
end $$;
create trigger payments_require_gateway before insert on public.payments
  for each row execute function public.payments_require_gateway();

create function public.payments_pending_sync()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'pending' and new.kind = 'order' and new.gateway_ref like 'PSP-%' then
    update public.orders set payment_status = 'pending' where id = new.order_id and payment_status is distinct from 'pending';
  end if;
  return null;
end $$;
create trigger payments_pending_sync after insert on public.payments
  for each row execute function public.payments_pending_sync();

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('refund_card', 'Refund sent back to the card', 'customer', 'Refund on its way to your card',
   '{amount} OMR for {order} is going back to your card ••{last4} (ref {ref}). Your bank usually shows it within 5–10 working days.',
   'الاسترداد في طريقه إلى بطاقتك',
   'يُعاد مبلغ {amount} ر.ع. للطلب {order} إلى بطاقتك ••{last4} (المرجع {ref}). يظهر عادةً لدى البنك خلال ٥ إلى ١٠ أيام عمل.',
   true, false, false, false, 'service', false)
on conflict (event) do nothing;

-- ===========================================================================
-- Refunds: back the way the customer paid
-- ===========================================================================
create or replace function public.refund_to_wallet(p_order uuid, p_amount numeric, p_kind text, p_memo text)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare
  o public.orders; pay public.payments; amt numeric := round(coalesce(p_amount, 0), 3);
  wallet_part numeric; card_part numeric; to_w numeric; to_c numeric; v_sum numeric; rf public.card_refunds;
begin
  if amt <= 0 then return 0; end if;
  select * into o from public.orders where id = p_order for update;
  if o.customer_id is null or o.billing = 'account' then return 0; end if;
  select * into pay from public.payments where order_id = p_order and kind = 'order' and status in ('authorized', 'captured', 'partially_refunded')
   order by created_at desc limit 1 for update;
  if not found then return 0; end if;
  if pay.method = 'cash' and pay.status = 'authorized' then
    -- Cash on delivery: nothing was collected; the order's payment is simply void.
    update public.payments set status = 'refunded' where id = pay.id;
    update public.orders set payment_status = 'refunded' where id = p_order;
    return 0;
  end if;
  amt := least(amt, pay.amount - pay.refunded_amount);
  if amt <= 0 then return 0; end if;
  -- What each source paid (older rows without the split count as wallet money, as before).
  card_part := case when pay.wallet_amount + pay.card_amount > 0 then pay.card_amount else 0 end;
  wallet_part := pay.amount - card_part;
  to_w := least(amt, greatest(wallet_part - (pay.refunded_amount - pay.refunded_to_card), 0));
  to_c := least(amt - to_w, greatest(card_part - pay.refunded_to_card, 0));
  v_sum := to_w + to_c;
  if v_sum <= 0 then return 0; end if;
  update public.payments
     set refunded_amount = refunded_amount + v_sum, refunded_to_card = refunded_to_card + to_c,
         status = case when refunded_amount + v_sum >= amount then 'refunded' else 'partially_refunded' end
   where id = pay.id;
  update public.orders set payment_status = case when pay.refunded_amount + v_sum >= pay.amount then 'refunded' else 'partially_refunded' end where id = p_order;
  if to_w > 0 then
    insert into public.wallet_tx (customer_id, kind, amount, order_id, memo) values (o.customer_id, p_kind, to_w, p_order, p_memo);
    perform public.notify(o.customer_id, 'refund_issued', p_order, jsonb_build_object('order', 'TO-' || o.order_no, 'amount', to_char(to_w, 'FM9990.000')));
  end if;
  if to_c > 0 then
    insert into public.card_refunds (payment_id, order_id, customer_id, amount, card_last4, status, gateway_ref, memo, completed_at)
    values (pay.id, p_order, o.customer_id, to_c, pay.card_last4,
            case when public.payment_simulator_on() and coalesce(pay.gateway_ref, '') not like 'PSP-%' then 'completed' else 'pending' end,
            'RF', left(coalesce(p_memo, ''), 300),
            case when public.payment_simulator_on() and coalesce(pay.gateway_ref, '') not like 'PSP-%' then now() end)
    returning * into rf;
    update public.card_refunds
       set gateway_ref = case when rf.status = 'completed' then 'SIM-RF-' else 'PSP-RF-' end || rf.refund_no
     where id = rf.id returning * into rf;
    perform public.notify(o.customer_id, 'refund_card', p_order, jsonb_build_object(
      'order', 'TO-' || o.order_no, 'amount', to_char(to_c, 'FM9990.000'), 'last4', coalesce(pay.card_last4, '····'), 'ref', rf.gateway_ref));
  end if;
  return v_sum;
end $$;

-- ===========================================================================
-- Top-ups
-- ===========================================================================
create or replace function public.wallet_topup(p_amount numeric, p_method text default 'card', p_card_last4 text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  amt numeric := round(coalesce(p_amount, 0), 3); tu public.topups; last4 text; sim boolean := public.payment_simulator_on();
  day_total numeric; pend numeric;
begin
  if public.my_role() is distinct from 'customer' then raise exception 'not_a_customer'; end if;
  if amt < 1 or amt > 500 then raise exception 'invalid_amount'; end if;
  if p_method not in ('card', 'omannet') then raise exception 'invalid_payment_method'; end if;
  last4 := case when p_card_last4 ~ '^[0-9]{4}$' then p_card_last4 when p_method = 'card' then '4417' end;
  perform public.lock_wallet(auth.uid());
  if sim then
    if coalesce(p_card_last4, '') = '0002' then raise exception 'payment_failed'; end if;
    select coalesce(sum(amount), 0) into day_total from public.topups
     where customer_id = auth.uid() and status in ('pending', 'confirmed') and created_at > now() - interval '24 hours' and gateway_ref like 'SIM-%';
    if day_total + amt > public.payment_simulator_num('daily_topup_omr', 50) then
      raise exception 'topup_daily_cap: % OMR a day in the demo', to_char(public.payment_simulator_num('daily_topup_omr', 50), 'FM9990');
    end if;
    select coalesce(sum(amount), 0) into pend from public.topups where customer_id = auth.uid() and status = 'pending';
    if public.wallet_balance(auth.uid()) + pend + amt > public.payment_simulator_num('wallet_cap_omr', 150) then
      raise exception 'wallet_cap_reached: % OMR at most in a demo wallet', to_char(public.payment_simulator_num('wallet_cap_omr', 150), 'FM9990');
    end if;
  end if;
  insert into public.topups (customer_id, amount, method, card_last4, status, gateway_ref)
  values (auth.uid(), amt, p_method, last4, 'pending', 'TU')
  returning * into tu;
  update public.topups set gateway_ref = case when sim then 'SIM-TU-' else 'PSP-TU-' end || tu.topup_no where id = tu.id returning * into tu;
  -- Simulator: confirmed at once, except card 0003 (the gateway answers later). Without the
  -- simulator the top-up waits for gateway_confirm (a verified gateway callback).
  if sim and coalesce(p_card_last4, '') <> '0003' then
    tu := public.credit_topup(tu.id);
  end if;
  return public.my_wallet() || jsonb_build_object('topup', to_jsonb(tu));
end $$;

-- pg_cron: the simulated gateway answers pending SIM payments after 20 seconds (simulator on only).
create or replace function public.confirm_simulated_payments()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare r record; t integer := 0; p integer := 0;
begin
  if auth.uid() is not null then perform public.require_staff(array['finance']::public.staff_role[]); end if;
  if not public.payment_simulator_on() then return jsonb_build_object('topups', 0, 'payments', 0, 'simulator', 'off'); end if;
  for r in select id from public.topups where status = 'pending' and gateway_ref like 'SIM-%' and created_at < now() - interval '20 seconds' loop
    perform public.credit_topup(r.id); t := t + 1;
  end loop;
  for r in select id from public.payments where status = 'pending' and coalesce(gateway_ref, '') like 'SIM-%' and created_at < now() - interval '20 seconds' loop
    perform public.confirm_order_payment(r.id); p := p + 1;
  end loop;
  return jsonb_build_object('topups', t, 'payments', p);
end $$;

-- ===========================================================================
-- Checkout (0043's wrapper): magic card numbers only with the simulator
-- ===========================================================================
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
declare
  o public.orders;
  sim boolean := public.payment_simulator_on();
  later boolean := public.payment_outage_on() and coalesce(p_pay_method, '') in ('card', 'omannet', 'wallet_card');
begin
  perform set_config('nama.pricing_point', case when p_lat is not null and p_lng is not null then p_lat::text || ',' || p_lng::text else '' end, true);
  -- The core still knows the simulator's 0002 decline: without the simulator (or in an outage)
  -- it never sees the card number, and the real one is stored afterwards.
  o := public.create_order_core(p_service_type, p_gallons, p_lat, p_lng, p_area, p_address, p_property_id, p_slot_start, p_slot_end,
                                p_slot_label, p_emergency, p_driver_note, p_pay_method, case when later or not sim then null else p_card_last4 end, p_promo_code);
  perform set_config('nama.pricing_point', '', true);
  if not sim then
    update public.payments set card_last4 = case when p_card_last4 ~ '^[0-9]{4}$' then p_card_last4 else card_last4 end
     where order_id = o.id and card_amount > 0;
    -- create_order_core marked the order authorized after inserting the payment; the gateway decides.
    update public.orders set payment_status = 'pending'
     where id = o.id and exists (select 1 from public.payments where order_id = o.id and kind = 'order' and status = 'pending');
    select * into o from public.orders where id = o.id;
  end if;
  update public.payments set confirmed_at = now() where order_id = o.id and status = 'authorized' and confirmed_at is null;
  if later and o.payment_status in ('authorized', 'pending') then
    update public.payments
       set status = 'pending', confirmed_at = null, gateway_ref = 'PAYLATER-' || o.order_no,
           card_last4 = case when p_card_last4 ~ '^[0-9]{4}$' then p_card_last4 else card_last4 end
     where order_id = o.id and status in ('authorized', 'pending') and card_amount > 0;
    if found then
      update public.orders set payment_status = 'pending', payment_followup = 'outage_pay_later', payment_followup_at = now()
       where id = o.id returning * into o;
      perform public.notify(o.customer_id, 'pay_later', o.id, jsonb_build_object('order', 'TO-' || o.order_no, 'total', to_char(o.total, 'FM9990.000')));
    end if;
  elsif sim and coalesce(p_card_last4, '') = '0003' and o.payment_status = 'authorized' then
    update public.payments set status = 'pending', confirmed_at = null where order_id = o.id and status = 'authorized' and card_amount > 0;
    if found then
      update public.orders set payment_status = 'pending' where id = o.id returning * into o;
    end if;
  end if;
  return o;
end $$;

-- ===========================================================================
-- Tips: company earnings only from a confirmed payment
-- ===========================================================================
create function public.credit_tip_earnings(p_order uuid, p_amount numeric)
returns void
language plpgsql security definer set search_path = public
as $$
declare o public.orders; co uuid;
begin
  select * into o from public.orders where id = p_order;
  co := public.tanker_company(o.tanker_id);
  if co is not null and p_amount > 0
     and not exists (select 1 from public.company_tx where order_id = o.id and kind = 'tip') then
    insert into public.company_tx (company_id, driver_id, tanker_id, kind, amount, order_id, memo)
    values (co, o.driver_id, o.tanker_id, 'tip', p_amount, o.id, 'Tip TO-' || o.order_no);
  end if;
end $$;

create or replace function public.rate_order(p_order_id uuid, p_rating integer, p_comment text default null, p_tip numeric default 0, p_tip_method text default 'wallet')
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; v_tip numeric := round(coalesce(p_tip, 0), 3); tp public.payments;
begin
  if p_rating is null or p_rating < 1 or p_rating > 5 then raise exception 'invalid_rating'; end if;
  if v_tip < 0 or v_tip > 20 then raise exception 'invalid_tip'; end if;
  if v_tip > 0 and coalesce(p_tip_method, '') not in ('wallet', 'card') then raise exception 'invalid_payment_method'; end if;
  select * into o from public.orders where id = p_order_id and customer_id = auth.uid() for update;
  if not found then raise exception 'not_found'; end if;
  if o.status <> 'delivered' then raise exception 'not_delivered'; end if;
  if o.rated_at is not null then raise exception 'already_rated'; end if;
  if v_tip > 0 then
    if p_tip_method = 'wallet' then
      perform public.lock_wallet(auth.uid());
      if public.wallet_balance(auth.uid()) < v_tip then raise exception 'insufficient_wallet'; end if;
      insert into public.wallet_tx (customer_id, kind, amount, order_id, memo) values (auth.uid(), 'tip', -v_tip, o.id, 'Tip for TO-' || o.order_no);
      perform public.credit_tip_earnings(o.id, v_tip);
    else
      -- Simulator: a captured card charge. Otherwise payments_require_gateway leaves it pending
      -- and the earnings follow the gateway's confirmation (gateway_confirm).
      insert into public.payments (order_id, customer_id, method, amount, card_amount, card_last4, status, gateway_ref, captured_at, kind)
      values (o.id, auth.uid(), 'card', v_tip, v_tip, coalesce((select last4 from public.payment_methods where customer_id = auth.uid() and is_default limit 1), '4417'),
              'captured', 'TIP-' || o.order_no, now(), 'tip')
      returning * into tp;
      if tp.status = 'captured' then perform public.credit_tip_earnings(o.id, v_tip); end if;
    end if;
  end if;
  update public.orders
     set rating = p_rating, rating_comment = nullif(left(btrim(coalesce(p_comment, '')), 500), ''), tip = v_tip, rated_at = now()
   where id = o.id returning * into o;
  if public.tanker_company(o.tanker_id) is not null then
    update public.companies c
       set rating = coalesce((select round(avg(x.rating)::numeric, 1) from public.orders x join public.tankers t on t.id = x.tanker_id
                              where t.company_id = c.id and x.rating is not null), c.rating)
     where c.id = public.tanker_company(o.tanker_id);
  end if;
  return o;
end $$;

-- ===========================================================================
-- The real-gateway entry point: service role only (a server route that verified the PSP's
-- signature calls it). Idempotent by reference; the amount must match exactly.
-- ===========================================================================
create function public.gateway_confirm(p_ref text, p_ok boolean, p_amount numeric, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare pay public.payments; tu public.topups; rf public.card_refunds; o public.orders; amt numeric := round(coalesce(p_amount, -1), 3);
begin
  if coalesce(p_ref, '') not like 'PSP-%' then raise exception 'unknown_reference'; end if;
  select * into tu from public.topups where gateway_ref = p_ref for update;
  if found then
    if tu.status <> 'pending' then return jsonb_build_object('kind', 'topup', 'status', tu.status, 'replay', true); end if;
    if amt <> tu.amount then raise exception 'amount_mismatch'; end if;
    if p_ok then tu := public.credit_topup(tu.id);
    else update public.topups set status = 'failed', failure_reason = left(coalesce(p_reason, 'Declined by the gateway'), 300) where id = tu.id returning * into tu;
    end if;
    return jsonb_build_object('kind', 'topup', 'status', tu.status);
  end if;
  select * into rf from public.card_refunds where gateway_ref = p_ref for update;
  if found then
    if rf.status <> 'pending' then return jsonb_build_object('kind', 'refund', 'status', rf.status, 'replay', true); end if;
    if amt <> rf.amount then raise exception 'amount_mismatch'; end if;
    update public.card_refunds set status = case when p_ok then 'completed' else 'failed' end, completed_at = case when p_ok then now() end
     where id = rf.id returning * into rf;
    return jsonb_build_object('kind', 'refund', 'status', rf.status);
  end if;
  select * into pay from public.payments where gateway_ref = p_ref for update;
  if not found then raise exception 'unknown_reference'; end if;
  if pay.status <> 'pending' then return jsonb_build_object('kind', pay.kind, 'status', pay.status, 'replay', true); end if;
  if amt <> pay.card_amount then raise exception 'amount_mismatch'; end if;
  if not p_ok then
    update public.payments set status = 'failed', failure_reason = left(coalesce(p_reason, 'Declined by the gateway'), 300) where id = pay.id returning * into pay;
    if pay.kind = 'order' then
      update public.orders set payment_status = 'failed', payment_followup = coalesce(payment_followup, 'payment_pending'),
                               payment_followup_at = coalesce(payment_followup_at, now())
       where id = pay.order_id;
    end if;
    return jsonb_build_object('kind', pay.kind, 'status', pay.status);
  end if;
  if pay.kind = 'tip' then
    update public.payments set status = 'captured', confirmed_at = now(), captured_at = now() where id = pay.id returning * into pay;
    perform public.credit_tip_earnings(pay.order_id, pay.amount);
  else
    pay := public.confirm_order_payment(pay.id);
  end if;
  return jsonb_build_object('kind', pay.kind, 'status', pay.status);
end $$;

-- ===========================================================================
-- Execute rights
-- ===========================================================================
revoke execute on function public.payments_require_gateway(), public.payments_pending_sync(), public.credit_tip_earnings(uuid, numeric),
  public.gateway_confirm(text, boolean, numeric, text) from public, anon, authenticated;
grant execute on function public.gateway_confirm(text, boolean, numeric, text) to service_role;
revoke execute on function public.payment_simulator_on(), public.payment_simulator_num(text, numeric) from public, anon;
grant execute on function public.payment_simulator_on(), public.payment_simulator_num(text, numeric) to authenticated;
