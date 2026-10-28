-- Fixes from the external code review (docs/review/codex-findings.md).
-- Each block names the finding it addresses.

-- ===========================================================================
-- Shared locks: wallet, organisation credit, tanker dispatch, contract
-- ===========================================================================
-- Every wallet debit takes this lock before checking the balance (M2).
create function public.lock_wallet(p_customer uuid)
returns void language sql
as $$ select pg_advisory_xact_lock(hashtext('nama.wallet:' || p_customer::text)) $$;

-- ===========================================================================
-- S5 / T5 — fleet eligibility: active company, permit inside its validity window
-- ===========================================================================
create or replace function public.tanker_has_valid_permit(p_tanker uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.permits p join public.tankers t on t.id = p.tanker_id
     where p.tanker_id = p_tanker and p.status = 'approved' and p.issued_at <= now() and p.expires_at > now() and p.type = t.service_type)
$$;

-- A tanker of a suspended (or not yet approved) company can't work.
create function public.tanker_company_active(p_tanker uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce((select c.status = 'active' from public.tankers t join public.companies c on c.id = t.company_id where t.id = p_tanker), true) $$;

create or replace function public.tanker_online_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.is_online and (tg_op = 'INSERT' or not old.is_online) then
    if new.blocked then raise exception 'tanker_blocked: %', coalesce(new.blocked_reason, 'blocked by NWS'); end if;
    if not public.tanker_company_active(new.id) then raise exception 'company_suspended'; end if;
    if not public.tanker_has_valid_permit(new.id) then raise exception 'permit_invalid'; end if;
  end if;
  return new;
end $$;

-- Suspending a company takes its fleet offline at once.
create or replace function public.staff_company_action(p_company_id uuid, p_action text, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare b text; r text;
begin
  perform public.require_staff(array['permit_officer', 'admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select status into b from public.companies where id = p_company_id for update;
  if not found then raise exception 'not_found'; end if;
  if p_action not in ('activate', 'suspend') then raise exception 'invalid_action'; end if;
  update public.companies set status = case when p_action = 'activate' then 'active' else 'suspended' end where id = p_company_id;
  if p_action = 'suspend' then
    update public.tankers set is_online = false where company_id = p_company_id and is_online;
    perform public.notify(m.id, 'penalty_issued', null, jsonb_build_object('amount', '0.000', 'reason', 'Company suspended by NWS: ' || r))
       from public.profiles m where m.company_id = p_company_id;
  end if;
  perform public.write_audit('company.' || p_action, 'company', p_company_id::text, jsonb_build_object('status', b),
                             jsonb_build_object('status', case when p_action = 'activate' then 'active' else 'suspended' end), r);
end $$;

-- ===========================================================================
-- S1 — legacy checkout goes through the same checks and payment as create_order
-- ===========================================================================
create or replace function public.place_order(
  p_service_type public.service_type,
  p_gallons      integer,
  p_lat          double precision,
  p_lng          double precision,
  p_area         text,
  p_address      text default ''
)
returns public.orders
language sql security definer set search_path = public
as $$
  select * from public.create_order(p_service_type => p_service_type, p_gallons => p_gallons, p_lat => p_lat, p_lng => p_lng,
                                    p_area => p_area, p_address => p_address, p_pay_method => 'card', p_card_last4 => '4417')
$$;

-- ===========================================================================
-- M1 — refunds never exceed what was actually collected; no payment, no refund
-- ===========================================================================
create or replace function public.refund_to_wallet(p_order uuid, p_amount numeric, p_kind text, p_memo text)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare o public.orders; pay public.payments; amt numeric := round(coalesce(p_amount, 0), 3);
begin
  if amt <= 0 then return 0; end if;
  select * into o from public.orders where id = p_order for update;
  if o.customer_id is null or o.billing = 'account' then return 0; end if;
  select * into pay from public.payments where order_id = p_order and status in ('authorized', 'captured', 'partially_refunded')
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
  update public.payments
     set refunded_amount = refunded_amount + amt,
         status = case when refunded_amount + amt >= amount then 'refunded' else 'partially_refunded' end
   where id = pay.id;
  update public.orders set payment_status = case when pay.refunded_amount + amt >= pay.amount then 'refunded' else 'partially_refunded' end where id = p_order;
  insert into public.wallet_tx (customer_id, kind, amount, order_id, memo) values (o.customer_id, p_kind, amt, p_order, p_memo);
  perform public.notify(o.customer_id, 'refund_issued', p_order, jsonb_build_object('order', 'TO-' || o.order_no, 'amount', to_char(amt, 'FM9990.000')));
  return amt;
end $$;

-- ===========================================================================
-- Checkout: wallet lock (M2), promotion reserved atomically (M9)
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
  me public.profiles;
  z public.zones;
  o public.orders;
  promo text := nullif(upper(btrim(coalesce(p_promo_code, ''))), '');
  bal numeric; w numeric := 0; c numeric := 0;
  st public.order_status := 'requested';
begin
  select * into me from public.profiles where id = auth.uid();
  if me.role is distinct from 'customer' then raise exception 'not_a_customer'; end if;
  if me.account_blocked then raise exception 'account_blocked'; end if;
  if p_gallons is null or p_gallons < 1 or p_gallons > 20000 then raise exception 'invalid_gallons'; end if;
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then raise exception 'invalid_location'; end if;
  if coalesce(btrim(p_area), '') = '' then raise exception 'area_required'; end if;
  if p_pay_method not in ('wallet', 'card', 'omannet', 'wallet_card') then raise exception 'invalid_payment_method'; end if;
  if p_property_id is not null and not exists (select 1 from public.properties where id = p_property_id and customer_id = auth.uid()) then
    raise exception 'not_found';
  end if;

  z := public.zone_at(p_lat, p_lng);
  if z.id is null then
    if (public.zone_at(p_lat, p_lng, true)).id is not null then raise exception 'zone_disabled'; end if;
    raise exception 'outside_service_area';
  end if;

  if p_slot_start is not null then
    if p_slot_end is null or p_slot_end <= p_slot_start then raise exception 'invalid_slot'; end if;
    if p_slot_end < now() then raise exception 'slot_in_past'; end if;
    if p_slot_start > now() + interval '2 hours' then st := 'scheduled'; end if;
  end if;

  -- Reserve one use of the promotion under its row lock (released by the rollback if checkout fails).
  if promo is not null then
    update public.promotions set uses = uses + 1
     where code = promo and active and uses < max_uses and (valid_to is null or valid_to >= current_date)
       and (audience in ('all', 'household')
            or (audience = 'new' and not exists (select 1 from public.orders where customer_id = auth.uid() and status = 'delivered')));
    if not found then raise exception 'invalid_promo'; end if;
  end if;

  perform public.lock_wallet(auth.uid());

  insert into public.orders (customer_id, service_type, gallons, area, property_id, zone_id, status, slot_start, slot_end, slot_label,
                             slot_peak, is_emergency, driver_note, promo_code, pay_method, channel)
  values (auth.uid(), p_service_type, p_gallons, left(btrim(p_area), 120), p_property_id, z.id, st, p_slot_start, p_slot_end,
          left(p_slot_label, 60), public.is_peak(p_slot_start), coalesce(p_emergency, false), nullif(left(btrim(coalesce(p_driver_note, '')), 300), ''),
          promo, p_pay_method, 'app')
  returning * into o;

  insert into public.order_locations (order_id, lat, lng, address)
  values (o.id, p_lat, p_lng, left(coalesce(btrim(p_address), ''), 300));

  -- Payment (simulated gateway: card ending 0002 is declined).
  bal := public.wallet_balance(auth.uid());
  if p_pay_method = 'wallet' then
    if bal < o.total then
      raise exception 'insufficient_wallet: balance % OMR, order total % OMR', to_char(bal, 'FM9990.000'), to_char(o.total, 'FM9990.000');
    end if;
    w := o.total;
  elsif p_pay_method = 'wallet_card' then
    w := least(greatest(bal, 0), o.total); c := o.total - w;
  else
    c := o.total;
  end if;

  if c > 0 and coalesce(p_card_last4, '') = '0002' then
    insert into public.payments (order_id, customer_id, method, amount, wallet_amount, card_amount, card_last4, status, gateway_ref, failure_reason)
    values (o.id, auth.uid(), p_pay_method, o.total, 0, c, p_card_last4, 'failed', 'SIM-' || o.order_no, 'Card declined by issuer (simulated)');
    update public.orders set status = 'cancelled', cancelled_at = now(), cancelled_by = 'system', cancel_reason = 'payment_failed', payment_status = 'failed'
     where id = o.id returning * into o;
    if promo is not null then update public.promotions set uses = greatest(uses - 1, 0) where code = promo; end if;
    return o;
  end if;

  if w > 0 then
    insert into public.wallet_tx (customer_id, kind, amount, order_id, memo) values (auth.uid(), 'payment', -w, o.id, 'TO-' || o.order_no);
  end if;
  insert into public.payments (order_id, customer_id, method, amount, wallet_amount, card_amount, card_last4, status, gateway_ref)
  values (o.id, auth.uid(), p_pay_method, o.total, w, c, case when c > 0 then coalesce(p_card_last4, '4417') end, 'authorized', 'SIM-' || o.order_no);
  update public.orders set payment_status = 'authorized' where id = o.id returning * into o;
  if o.status = 'requested' then
    perform public.notify(auth.uid(), 'order_confirmed', o.id, jsonb_build_object('order', 'TO-' || o.order_no, 'total', to_char(o.total, 'FM9990.000')));
  end if;
  return o;
end $$;

-- ===========================================================================
-- M2 / M3 — tips: wallet (locked) or a recorded card charge; nothing else
-- ===========================================================================
create or replace function public.rate_order(p_order_id uuid, p_rating integer, p_comment text default null, p_tip numeric default 0, p_tip_method text default 'wallet')
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; v_tip numeric := round(coalesce(p_tip, 0), 3); co uuid;
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
    else
      -- Simulated card charge, recorded like any other collected payment.
      insert into public.payments (order_id, customer_id, method, amount, card_amount, card_last4, status, gateway_ref, captured_at)
      values (o.id, auth.uid(), 'card', v_tip, v_tip, coalesce((select last4 from public.payment_methods where customer_id = auth.uid() and is_default limit 1), '4417'),
              'captured', 'TIP-' || o.order_no, now());
    end if;
    co := public.tanker_company(o.tanker_id);
    if co is not null then
      insert into public.company_tx (company_id, driver_id, tanker_id, kind, amount, order_id, memo)
      values (co, o.driver_id, o.tanker_id, 'tip', v_tip, o.id, 'Tip TO-' || o.order_no);
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

-- Customer fines debit the wallet under the same lock.
create or replace function public.issue_penalty(p_rule text, p_order uuid, p_tanker uuid, p_reason text, p_evidence text default '', p_amount numeric default null)
returns public.penalties
language plpgsql security definer set search_path = public
as $$
declare rule public.penalty_rules; o public.orders; p public.penalties; amt numeric;
begin
  select * into rule from public.penalty_rules where code = p_rule;
  if not found then raise exception 'unknown_penalty_rule'; end if;
  if not rule.active then return null; end if;
  if p_order is not null then select * into o from public.orders where id = p_order; end if;
  amt := coalesce(p_amount, case when rule.amount_kind = 'pct' then round(coalesce(o.total, 0) * rule.amount / 100, 3) else rule.amount end);
  if p_order is not null and exists (select 1 from public.penalties where order_id = p_order and rule_code = p_rule and state <> 'cancelled') then
    return null;
  end if;
  insert into public.penalties (rule_code, company_id, tanker_id, driver_id, order_id, customer_id, org_id, amount, reason, evidence, created_by)
  values (p_rule,
          case when rule.party = 'driver' then public.tanker_company(coalesce(p_tanker, o.tanker_id)) end,
          case when rule.party = 'driver' then coalesce(p_tanker, o.tanker_id) end,
          case when rule.party = 'driver' then coalesce(o.driver_id, (select driver_id from public.tanker_assignments where tanker_id = p_tanker and unassigned_at is null)) end,
          p_order,
          case when rule.party = 'customer' then o.customer_id end,
          case when rule.party = 'business' then o.org_id end,
          amt, p_reason, coalesce(p_evidence, ''), auth.uid())
  returning * into p;
  if p.company_id is not null and amt > 0 then
    insert into public.company_tx (company_id, driver_id, tanker_id, kind, amount, order_id, penalty_id, memo)
    values (p.company_id, p.driver_id, p.tanker_id, 'penalty', -amt, p_order, p.id, rule.label);
    perform public.notify(m.id, 'penalty_issued', p_order, jsonb_build_object('amount', to_char(amt, 'FM9990.000'), 'reason', rule.label))
       from public.profiles m where m.company_id = p.company_id and m.role = 'owner';
    perform public.notify(p.driver_id, 'penalty_issued', p_order, jsonb_build_object('amount', to_char(amt, 'FM9990.000'), 'reason', rule.label));
  elsif p.customer_id is not null and amt > 0 then
    perform public.lock_wallet(p.customer_id);
    insert into public.wallet_tx (customer_id, kind, amount, order_id, memo) values (p.customer_id, 'cancel_fee', -amt, p_order, rule.label);
  end if;
  return p;
end $$;

-- ===========================================================================
-- M8 — contract discounts are rules: they appear in rules_used and the statuses
-- ===========================================================================
create or replace function public.price_order()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  q record;
  mode text;
  bad text;
  pct numeric := public.order_discount_pct(new.promo_code, new.contract_id);
  disc_rule text;
  disc_status public.rule_status;
  used text[];
begin
  select * into q from public.price_quote_ext(new.service_type, new.gallons, new.slot_peak, new.is_emergency, pct);
  used := q.rules_used;
  -- A contract discount (no promotion) comes from a pricing rule; promotions are commercial decisions.
  if pct > 0 and new.contract_id is not null and not exists (select 1 from public.promotions where code = new.promo_code) then
    disc_rule := (select case c.plan when 'yearly' then 'discount_yearly' else 'discount_monthly' end from public.contracts c where c.id = new.contract_id);
    select status into disc_status from public.pricing_rules where rule_key = disc_rule;
    used := array_append(used, disc_rule);
  end if;
  select value into mode from public.app_settings where key = 'BILLING_MODE';
  mode := coalesce(mode, 'demo');

  if mode = 'production' then
    select string_agg(format('%s (%s, %s)', p.rule_key, p.status, p.source), ', ' order by p.rule_key) into bad
      from public.pricing_rules p
     where p.rule_key = any(used) and p.status <> 'confirmed';
    if bad is not null then
      raise exception 'pricing_unconfirmed: BILLING_MODE is production and these pricing rules are not confirmed: %', bad;
    end if;
  end if;

  new.water_charge    := q.water_charge;
  new.delivery_fee    := q.delivery_fee;
  new.discount        := q.discount;
  new.vat             := q.vat;
  new.total           := q.total;
  new.driver_earnings := q.driver_earnings;
  new.price_basis := jsonb_build_object(
    'water', q.water_status,
    'fee', case when disc_status is null then q.fee_status else public.worst_status(q.fee_status, disc_status) end,
    'vat', case when disc_status is null then q.vat_status else public.worst_status(q.vat_status, disc_status) end,
    'total', case when disc_status is null then q.total_status else public.worst_status(q.total_status, disc_status) end,
    'earnings', q.earnings_status,
    'rules', to_jsonb(used), 'mode', mode);
  if new.slot_peak or new.is_emergency or pct > 0 then
    new.price_basis := new.price_basis || jsonb_build_object('peak', new.slot_peak, 'priority', new.is_emergency, 'discount_pct', pct);
  end if;
  return new;
end $$;

-- ===========================================================================
-- M10 — a customer reschedule can't move an order across the peak boundary
-- (the price is frozen at booking); NWS staff can, as an audited override.
-- ===========================================================================
create or replace function public.reschedule_order(p_order_id uuid, p_slot_start timestamptz, p_slot_end timestamptz, p_slot_label text)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders;
begin
  if p_slot_start is null or p_slot_end is null or p_slot_end <= p_slot_start or p_slot_end < now() then raise exception 'invalid_slot'; end if;
  select * into o from public.orders where id = p_order_id and customer_id = auth.uid() and status in ('scheduled', 'requested') for update;
  if not found then raise exception 'cannot_reschedule'; end if;
  if public.is_peak(p_slot_start) is distinct from o.slot_peak then raise exception 'reschedule_changes_price'; end if;
  update public.orders
     set slot_start = p_slot_start, slot_end = p_slot_end, slot_label = left(p_slot_label, 60),
         status = case when p_slot_start > now() + interval '2 hours' then 'scheduled'::public.order_status else 'requested'::public.order_status end
   where id = o.id
  returning * into o;
  return o;
end $$;

-- ===========================================================================
-- T1 / P2 — completion needs proof of delivery; the photo must be a real upload
-- ===========================================================================
-- Legacy one-step completion now requires a proof of delivery already on file,
-- and never applies to wastewater (collect → discharge).
create or replace function public.mark_delivered(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order_id and driver_id = auth.uid() and status = 'arrived' for update;
  if not found then raise exception 'invalid_transition'; end if;
  if o.service_type = 'WW' then raise exception 'use_confirm_discharge'; end if;
  if not exists (select 1 from public.pods where order_id = o.id) then raise exception 'pod_required'; end if;
  update public.orders set status = 'delivered', delivered_at = now() where id = o.id returning * into o;
  perform public.settle_order(o.id);
  select * into o from public.orders where id = o.id;
  return o;
end $$;

-- An uploaded photo in the caller's own evidence folder (when Storage exists).
create function public.evidence_object_ok(p_path text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_path is null or split_part(p_path, '/', 1) <> auth.uid()::text then return false; end if;
  if to_regclass('storage.objects') is null then return true; end if;  -- PGlite tests: no Storage
  return exists (select 1 from storage.objects where bucket_id = 'evidence' and name = p_path);
end $$;

-- M7: a short delivery refunds the missing share of the water to the customer
-- (prepaid) or credits it against the account (business), alongside the penalty.
alter table public.orders add column short_credit numeric(10,3) not null default 0;

create or replace function public.submit_pod(p_order_id uuid, p_meter_gal integer, p_photo_path text default null, p_photo_hash text default null,
                                             p_signature_svg text default null, p_no_signature boolean default false, p_left_at_tank boolean default false,
                                             p_lat double precision default null, p_lng double precision default null)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; t public.tankers; credit numeric;
begin
  t := public.my_tanker();
  select * into o from public.orders where id = p_order_id and driver_id = auth.uid() for update;
  if not found then raise exception 'not_found'; end if;
  if o.status <> 'arrived' then raise exception 'invalid_transition'; end if;
  if p_meter_gal is null or p_meter_gal < 0 or p_meter_gal > 20000 then raise exception 'invalid_meter'; end if;
  if coalesce(p_signature_svg, '') = '' and not coalesce(p_no_signature, false) then raise exception 'signature_required'; end if;
  if not public.evidence_object_ok(p_photo_path) then raise exception 'photo_required'; end if;
  insert into public.pods (order_id, kind, photo_path, photo_hash, meter_gal, signature_svg, no_signature, left_at_tank, lat, lng)
  values (o.id, case when o.service_type = 'WW' then 'collection' else 'delivery' end, p_photo_path, p_photo_hash, p_meter_gal,
          nullif(p_signature_svg, ''), coalesce(p_no_signature, false), coalesce(p_left_at_tank, false),
          coalesce(p_lat, t.last_lat), coalesce(p_lng, t.last_lng));
  if o.service_type = 'WW' then
    update public.orders set status = 'collected', collected_at = now() where id = o.id returning * into o;
  else
    update public.orders set status = 'delivered', delivered_at = now() where id = o.id returning * into o;
    perform public.settle_order(o.id);
    select * into o from public.orders where id = o.id;
  end if;
  if o.service_type <> 'WW' and p_meter_gal < o.gallons * 0.95 then
    perform public.issue_penalty('short_volume', o.id, o.tanker_id,
      format('Delivered %s of %s gal (%s%% short)', p_meter_gal, o.gallons, round((1 - p_meter_gal::numeric / o.gallons) * 100)), 'Flow meter reading on proof of delivery');
    perform public.raise_alert(o.tanker_id, o.id, 'Short volume', 'med', format('TO-%s: %s of %s gal delivered', o.order_no, p_meter_gal, o.gallons),
                               t.last_lat, t.last_lng, 'short:' || o.id);
    -- Pro-rata share of the order for the missing volume.
    credit := round(o.total * (1 - p_meter_gal::numeric / o.gallons), 3);
    if o.billing = 'account' then
      update public.orders set short_credit = credit where id = o.id returning * into o;
    else
      perform public.refund_to_wallet(o.id, credit, 'refund', format('Short delivery TO-%s: %s of %s gal', o.order_no, p_meter_gal, o.gallons));
      update public.orders set short_credit = credit where id = o.id returning * into o;
    end if;
  end if;
  return o;
end $$;

-- ===========================================================================
-- T5 — applications from owners/drivers need the full review before approval
-- ===========================================================================
create or replace function public.staff_review_permit(p_permit_id uuid, p_decision text, p_reason text)
returns public.permits
language plpgsql security definer set search_path = public
as $$
declare b public.permits; a public.permits; r text;
begin
  perform public.require_staff(array['permit_officer']::public.staff_role[]);
  if p_decision not in ('approve', 'reject') then raise exception 'invalid_decision'; end if;
  r := case when p_decision = 'reject' then public.require_reason(p_reason) else nullif(btrim(coalesce(p_reason, '')), '') end;
  select * into b from public.permits where id = p_permit_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.status <> 'pending' then raise exception 'invalid_state: only pending permits can be reviewed'; end if;
  -- Applications (applied_by set) go through documents → inspection → decision; permits
  -- created directly by a permit officer are the audited override path.
  if p_decision = 'approve' and b.applied_by is not null then
    if b.stage <> 'decision' then raise exception 'permit_review_incomplete: the application is at the % stage', b.stage; end if;
    if not exists (select 1 from public.inspections i where i.tanker_id = b.tanker_id and i.result = 'pass'
                     and (i.permit_id = b.id or i.created_at >= b.created_at)) then
      raise exception 'permit_review_incomplete: no passed inspection for this application';
    end if;
  end if;
  update public.permits
     set status = case when p_decision = 'approve' then 'approved'::public.permit_status else 'rejected'::public.permit_status end,
         reviewed_by = auth.uid(), reviewed_at = now(), reason = r, updated_at = now()
   where id = p_permit_id returning * into a;
  perform public.write_audit('permit.' || p_decision, 'permit', a.id::text, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

-- Stages move one step at a time (request_info doesn't change the stage).
create or replace function public.staff_permit_stage(p_permit_id uuid, p_stage text, p_note text default null)
returns public.permits
language plpgsql security definer set search_path = public
as $$
declare b public.permits; a public.permits;
begin
  perform public.require_staff(array['permit_officer']::public.staff_role[]);
  select * into b from public.permits where id = p_permit_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.status <> 'pending' then raise exception 'invalid_state: only pending applications move through stages'; end if;
  if p_stage = 'request_info' then
    update public.permits set info_requested = public.require_reason(p_note), updated_at = now() where id = b.id returning * into a;
  elsif (b.stage, p_stage) in (('submitted', 'documents'), ('documents', 'inspection'), ('inspection', 'decision')) then
    if p_stage = 'decision' and not exists (select 1 from public.inspections i where i.tanker_id = b.tanker_id and i.result = 'pass'
                                              and (i.permit_id = b.id or i.created_at >= b.created_at)) then
      raise exception 'permit_review_incomplete: record a passed inspection first';
    end if;
    update public.permits set stage = p_stage, info_requested = null, updated_at = now() where id = b.id returning * into a;
  else raise exception 'invalid_stage'; end if;
  perform public.write_audit('permit.stage', 'permit', b.id::text, jsonb_build_object('stage', b.stage, 'info_requested', b.info_requested),
                             jsonb_build_object('stage', a.stage, 'info_requested', a.info_requested), p_note);
  return a;
end $$;

-- ===========================================================================
-- T6 / S5 — dispatch locks the tanker and checks company status
-- ===========================================================================
create or replace function public.accept_order(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare
  t public.tankers;
  o public.orders;
  v_name text;
begin
  t := public.my_tanker();
  -- Serialise with assignment changes on this tanker, then re-check the assignment.
  select * into t from public.tankers where id = t.id for update;
  if public.my_tanker_id() is distinct from t.id then raise exception 'no_tanker'; end if;
  if t.blocked then raise exception 'tanker_blocked: %', coalesce(t.blocked_reason, 'blocked by NWS'); end if;
  if not public.tanker_company_active(t.id) then raise exception 'company_suspended'; end if;
  if not public.tanker_has_valid_permit(t.id) then raise exception 'permit_invalid'; end if;
  if not t.is_online then raise exception 'driver_offline'; end if;

  if exists (select 1 from public.orders
             where (driver_id = auth.uid() or tanker_id = t.id) and status in ('accepted', 'arriving', 'arrived', 'collected')) then
    raise exception 'driver_busy';
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();

  begin
    update public.orders
       set status = 'accepted',
           driver_id = auth.uid(),
           tanker_id = t.id,
           accepted_at = now(),
           driver_name = nullif(v_name, ''),
           tanker_plate = t.plate
     where id = p_order_id
       and status = 'requested'
       and service_type = t.service_type
       and gallons <= t.capacity_gal
       and (contract_id is null or exists (select 1 from public.contracts k where k.id = contract_id and k.company_id = t.company_id and k.status = 'active'))
    returning * into o;
  exception when unique_violation then
    raise exception 'driver_busy';
  end;

  if not found then
    if exists (select 1 from public.orders where id = p_order_id and status = 'requested') then
      raise exception 'not_eligible';
    end if;
    raise exception 'already_taken';
  end if;
  return o;
end $$;

create or replace function public.open_requests_near(p_lat double precision, p_lng double precision)
returns table (
  id              uuid,
  order_no        bigint,
  service_type    public.service_type,
  gallons         integer,
  area            text,
  distance_km     numeric,
  driver_earnings numeric(10,3),
  earnings_status text,
  created_at      timestamptz,
  is_emergency    boolean,
  slot_label      text,
  slot_end        timestamptz,
  channel         text,
  contract_no     bigint
)
language plpgsql security definer set search_path = public
as $$
declare t public.tankers;
begin
  t := public.my_tanker();
  perform public.release_due_orders();
  if not t.is_online or t.blocked or not public.tanker_company_active(t.id) or not public.tanker_has_valid_permit(t.id) then return; end if;

  return query
    select o.id, o.order_no, o.service_type, o.gallons, o.area,
           round(public.km(p_lat, p_lng, l.lat, l.lng)::numeric, 1) as distance_km,
           o.driver_earnings, o.price_basis ->> 'earnings', o.created_at, o.is_emergency, o.slot_label, o.slot_end, o.channel,
           k.contract_no
      from public.orders o
      join public.order_locations l on l.order_id = o.id
      left join public.contracts k on k.id = o.contract_id
     where o.status = 'requested'
       and o.service_type = t.service_type
       and o.gallons <= t.capacity_gal
       and (o.contract_id is null or (k.company_id = t.company_id and k.status = 'active'))
     order by o.is_emergency desc, 6, o.created_at
     limit 50;
end $$;

create or replace function public.owner_assign_driver(p_driver_id uuid, p_tanker_id uuid)
returns public.tanker_assignments
language plpgsql security definer set search_path = public
as $$
declare a public.tanker_assignments; old_tanker uuid;
begin
  if not public.is_owner() or not public.in_my_company(p_tanker_id) then raise exception 'not_found'; end if;
  if not exists (select 1 from public.profiles where id = p_driver_id and role = 'driver' and company_id = public.my_company_id()) then raise exception 'not_found'; end if;
  select tanker_id into old_tanker from public.tanker_assignments where driver_id = p_driver_id and unassigned_at is null;
  -- Lock both tankers (in a fixed order) against concurrent job acceptance.
  perform 1 from public.tankers where id in (p_tanker_id, old_tanker) order by id for update;
  if exists (select 1 from public.orders where (tanker_id in (p_tanker_id, old_tanker) or driver_id = p_driver_id) and status in ('accepted', 'arriving', 'arrived', 'collected')) then
    raise exception 'tanker_on_job';
  end if;
  update public.tanker_assignments set unassigned_at = now() where (tanker_id = p_tanker_id or driver_id = p_driver_id) and unassigned_at is null;
  update public.tankers set is_online = false where id in (p_tanker_id, old_tanker);
  insert into public.tanker_assignments (driver_id, tanker_id, assigned_by) values (p_driver_id, p_tanker_id, auth.uid()) returning * into a;
  return a;
end $$;

create or replace function public.owner_unassign(p_tanker_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_owner() or not public.in_my_company(p_tanker_id) then raise exception 'not_found'; end if;
  perform 1 from public.tankers where id = p_tanker_id for update;
  if exists (select 1 from public.orders where tanker_id = p_tanker_id and status in ('accepted', 'arriving', 'arrived', 'collected')) then raise exception 'tanker_on_job'; end if;
  update public.tanker_assignments set unassigned_at = now() where tanker_id = p_tanker_id and unassigned_at is null;
  update public.tankers set is_online = false where id = p_tanker_id;
end $$;

create or replace function public.staff_unassign_tanker(p_tanker_id uuid, p_reason text)
returns public.tanker_assignments
language plpgsql security definer set search_path = public
as $$
declare a public.tanker_assignments; r text;
begin
  perform public.require_staff(array['operator']::public.staff_role[]);
  r := public.require_reason(p_reason);
  perform 1 from public.tankers where id = p_tanker_id for update;
  select * into a from public.tanker_assignments where tanker_id = p_tanker_id and unassigned_at is null for update;
  if not found then raise exception 'not_assigned'; end if;
  if exists (select 1 from public.orders where tanker_id = p_tanker_id and status in ('accepted', 'arriving', 'arrived', 'collected')) then
    raise exception 'tanker_on_job';
  end if;
  update public.tanker_assignments set unassigned_at = now() where id = a.id returning * into a;
  update public.tankers set is_online = false where id = p_tanker_id;
  perform public.write_audit('tanker.unassign', 'tanker', p_tanker_id::text,
    jsonb_build_object('driver_id', a.driver_id, 'assignment_id', a.id), null, r);
  return a;
end $$;

-- Staff assignment of an order: same eligibility (company active) and tanker lock.
create or replace function public.staff_order_action(p_order_id uuid, p_action text, p_reason text, p_tanker_id uuid default null, p_amount numeric default null,
                                                     p_slot_start timestamptz default null, p_slot_end timestamptz default null, p_slot_label text default null)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare b public.orders; a public.orders; r text; t public.tankers; drv uuid; nm text;
begin
  r := public.require_reason(p_reason);
  select * into b from public.orders where id = p_order_id for update;
  if not found then raise exception 'not_found'; end if;
  if p_action = 'assign' then
    perform public.require_staff(array['operator']::public.staff_role[]);
    if b.status <> 'requested' then raise exception 'invalid_state: only open requests can be assigned'; end if;
    select * into t from public.tankers where id = p_tanker_id for update;
    if not found then raise exception 'not_found'; end if;
    if t.blocked or not public.tanker_company_active(t.id) or not public.tanker_has_valid_permit(t.id) then raise exception 'tanker_not_eligible'; end if;
    if t.service_type <> b.service_type or t.capacity_gal < b.gallons then raise exception 'tanker_not_eligible'; end if;
    if b.contract_id is not null and not exists (select 1 from public.contracts k where k.id = b.contract_id and k.company_id = t.company_id) then
      raise exception 'tanker_not_eligible';
    end if;
    select driver_id into drv from public.tanker_assignments where tanker_id = t.id and unassigned_at is null;
    if drv is null then raise exception 'tanker_has_no_driver'; end if;
    if exists (select 1 from public.orders where (tanker_id = t.id or driver_id = drv) and status in ('accepted', 'arriving', 'arrived', 'collected')) then raise exception 'driver_busy'; end if;
    select full_name into nm from public.profiles where id = drv;
    update public.orders set status = 'accepted', driver_id = drv, tanker_id = t.id, accepted_at = now(), driver_name = nullif(nm, ''), tanker_plate = t.plate
     where id = b.id returning * into a;
    perform public.notify(drv, 'job_assigned', b.id, jsonb_build_object('order', 'TO-' || b.order_no, 'area', b.area));
  elsif p_action = 'cancel' then
    perform public.require_staff(array['operator']::public.staff_role[]);
    if b.status in ('delivered', 'cancelled') then raise exception 'invalid_state'; end if;
    update public.orders set status = 'cancelled', cancelled_at = now(), cancelled_by = 'staff', cancel_reason = r where id = b.id returning * into a;
    perform public.refund_to_wallet(b.id, b.total, 'refund', 'Cancelled by NWS: TO-' || b.order_no);
  elsif p_action = 'reschedule' then
    perform public.require_staff(array['operator']::public.staff_role[]);
    if b.status not in ('requested', 'scheduled') then raise exception 'invalid_state'; end if;
    if p_slot_start is null or p_slot_end is null or p_slot_end <= p_slot_start then raise exception 'invalid_slot'; end if;
    -- Staff override: the frozen price is kept; the slot's peak class is recorded as it now is.
    update public.orders set slot_start = p_slot_start, slot_end = p_slot_end, slot_label = left(coalesce(p_slot_label, to_char(p_slot_start at time zone 'Asia/Muscat', 'Dy DD Mon HH24:MI')), 60),
                             status = case when p_slot_start > now() + interval '2 hours' then 'scheduled'::public.order_status else 'requested'::public.order_status end
     where id = b.id returning * into a;
  elsif p_action = 'refund' then
    perform public.require_staff(array['operator', 'finance', 'complaints_agent']::public.staff_role[]);
    if coalesce(p_amount, 0) <= 0 then raise exception 'invalid_amount'; end if;
    if public.refund_to_wallet(b.id, p_amount, 'refund', 'NWS refund TO-' || b.order_no || ': ' || r) = 0 then raise exception 'nothing_to_refund'; end if;
    select * into a from public.orders where id = b.id;
  else raise exception 'invalid_action'; end if;
  perform public.write_audit('order.' || p_action, 'order', b.id::text,
    jsonb_build_object('status', b.status, 'tanker_plate', b.tanker_plate, 'slot', b.slot_label, 'payment_status', b.payment_status),
    jsonb_build_object('status', a.status, 'tanker_plate', a.tanker_plate, 'slot', a.slot_label, 'payment_status', a.payment_status, 'amount', p_amount), r);
  return a;
end $$;

-- ===========================================================================
-- T2 / T3 / M6 — contracts: one occurrence per slot, stopped by pause/end,
-- household deliveries charged to the saved card, business ones to the account
-- ===========================================================================
create unique index orders_contract_occurrence on public.orders (contract_id, slot_start) where contract_id is not null and status <> 'cancelled';

create or replace function public.generate_contract_orders(p_contract uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare c record; d date; n integer := 0; step interval; s timestamptz; o public.orders; who uuid; org public.organizations; q record;
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
          -- Household contracts auto-pay with the customer's saved card (simulated authorisation).
          insert into public.payments (order_id, customer_id, method, amount, card_amount, card_last4, status, gateway_ref)
          values (o.id, who, 'card', o.total, o.total,
                  coalesce((select last4 from public.payment_methods where customer_id = who and is_default limit 1), '4417'), 'authorized', 'CT-' || c.contract_no || '-' || o.order_no);
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

-- Pausing or ending stops every occurrence not yet taken by a driver.
create or replace function public.contract_set_status(p_contract_id uuid, p_action text)
returns public.contracts
language plpgsql security definer set search_path = public
as $$
declare c public.contracts; o record;
begin
  select * into c from public.contracts where id = p_contract_id
     and (customer_id = auth.uid() or (org_id = public.my_org_id() and coalesce(public.my_org_role(), '') in ('admin', 'site_manager'))) for update;
  if not found then raise exception 'not_found'; end if;
  perform pg_advisory_xact_lock(hashtext('nama.contract:' || c.id::text));
  if p_action = 'pause' and c.status = 'active' then update public.contracts set status = 'paused' where id = c.id returning * into c;
  elsif p_action = 'resume' and c.status = 'paused' then
    update public.contracts set status = 'active' where id = c.id returning * into c;
    perform public.generate_contract_orders(c.id);
  elsif p_action = 'end' and c.status in ('pending_owner', 'active', 'paused') then
    update public.contracts set status = 'ended', end_date = greatest(current_date, start_date + 1) where id = c.id returning * into c;
  else raise exception 'invalid_transition'; end if;
  if c.status in ('paused', 'ended') then
    for o in select id from public.orders where contract_id = c.id and status in ('scheduled', 'requested') loop
      update public.orders set status = 'cancelled', cancelled_at = now(), cancelled_by = 'customer',
                               cancel_reason = 'Contract ' || case when c.status = 'paused' then 'paused' else 'ended' end
       where id = o.id;
      perform public.refund_to_wallet(o.id, (select total from public.orders where id = o.id), 'refund', 'Contract delivery cancelled');
    end loop;
  end if;
  return c;
end $$;

-- Scheduled occurrences of contracts that are no longer active are cancelled, not released.
create or replace function public.release_due_orders()
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  update public.orders o set status = 'cancelled', cancelled_at = now(), cancelled_by = 'system', cancel_reason = 'Contract not active'
   where o.status = 'scheduled' and o.contract_id is not null
     and exists (select 1 from public.contracts k where k.id = o.contract_id and k.status <> 'active');
  update public.orders set status = 'requested', released_at = now()
   where status = 'scheduled' and slot_start <= now() + interval '90 minutes';
  get diagnostics n = row_count;
  return n;
end $$;

-- ===========================================================================
-- M4 / M5 — business accounts: serialised credit checks and invoicing
-- ===========================================================================
-- Credit used includes orders awaiting approval (they are reserved).
create or replace function public.org_outstanding(p_org uuid)
returns numeric language sql stable security definer set search_path = public
as $$
  select coalesce((select sum(total - short_credit) from public.orders where org_id = p_org and billing = 'account' and invoice_id is null and status <> 'cancelled'), 0)
       + coalesce((select sum(total) from public.invoices where org_id = p_org and status <> 'paid'), 0)
$$;

create or replace function public.org_create_orders(p_property_id uuid, p_service_type public.service_type, p_gallons integer, p_count integer,
                                                    p_slot_start timestamptz default null, p_slot_end timestamptz default null, p_slot_label text default null,
                                                    p_po_number text default null, p_note text default null)
returns setof public.orders
language plpgsql security definer set search_path = public
as $$
declare
  org public.organizations; prop public.properties; o public.orders; q record; st public.order_status; i integer; z public.zones;
begin
  if coalesce(public.my_org_role(), '') not in ('admin', 'site_manager') then raise exception 'forbidden_for_role'; end if;
  select * into org from public.organizations where id = public.my_org_id() for update;
  if org.status <> 'active' then raise exception 'account_not_active'; end if;
  if org.paused then raise exception 'account_paused'; end if;
  select * into prop from public.properties where id = p_property_id and org_id = org.id;
  if not found then raise exception 'not_found'; end if;
  if p_count is null or p_count < 1 or p_count > 20 then raise exception 'invalid_count'; end if;
  if p_gallons is null or p_gallons < 100 or p_gallons > 20000 then raise exception 'invalid_gallons'; end if;
  if p_slot_start is not null and (p_slot_end is null or p_slot_end <= p_slot_start or p_slot_end < now()) then raise exception 'invalid_slot'; end if;
  z := public.zone_at(prop.lat, prop.lng);
  if z.id is null then raise exception 'outside_service_area'; end if;
  select * into q from public.price_quote_ext(p_service_type, p_gallons, public.is_peak(p_slot_start), false, 0);
  if public.org_outstanding(org.id) + q.total * p_count > org.credit_limit then raise exception 'credit_limit_exceeded'; end if;
  st := case when public.my_org_role() <> 'admin' and q.total * p_count > org.approval_limit then 'pending_approval'::public.order_status
             when p_slot_start is not null and p_slot_start > now() + interval '2 hours' then 'scheduled'::public.order_status
             else 'requested'::public.order_status end;
  for i in 1 .. p_count loop
    insert into public.orders (customer_id, org_id, service_type, gallons, area, property_id, zone_id, status, slot_start, slot_end, slot_label, slot_peak,
                               driver_note, po_number, channel, billing, pay_method, payment_status)
    values (auth.uid(), org.id, p_service_type, p_gallons, coalesce(nullif(prop.area, ''), prop.label), prop.id, z.id, st, p_slot_start, p_slot_end,
            left(p_slot_label, 60), public.is_peak(p_slot_start), nullif(left(btrim(coalesce(p_note, '')), 300), ''), nullif(btrim(coalesce(p_po_number, '')), ''),
            'business', 'account', 'account', 'on_account')
    returning * into o;
    insert into public.order_locations (order_id, lat, lng, address) values (o.id, prop.lat, prop.lng, prop.label || ' — ' || coalesce(prop.address, ''));
    insert into public.payments (order_id, org_id, customer_id, method, amount, status) values (o.id, org.id, auth.uid(), 'account', o.total, 'on_account');
    return next o;
  end loop;
end $$;

-- Approval re-checks the account is still active and not paused (credit was reserved at ordering).
create or replace function public.org_decide_order(p_order_id uuid, p_approve boolean, p_reason text default null)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; org public.organizations;
begin
  if coalesce(public.my_org_role(), '') <> 'admin' then raise exception 'forbidden_for_role'; end if;
  select * into org from public.organizations where id = public.my_org_id() for update;
  if p_approve and (org.status <> 'active' or org.paused) then raise exception 'account_paused'; end if;
  update public.orders
     set status = case when not p_approve then 'cancelled'::public.order_status
                       when slot_start is not null and slot_start > now() + interval '2 hours' then 'scheduled'::public.order_status
                       else 'requested'::public.order_status end,
         approved_by = auth.uid(), approved_at = now(),
         cancelled_at = case when p_approve then null else now() end,
         cancelled_by = case when p_approve then null else 'approver' end,
         cancel_reason = case when p_approve then null else coalesce(nullif(btrim(p_reason), ''), 'Not approved') end
   where id = p_order_id and org_id = org.id and status = 'pending_approval'
  returning * into o;
  if not found then raise exception 'not_found'; end if;
  return o;
end $$;

-- One invoice at a time per organisation, over a fixed set of orders; short-delivery credits deducted.
create or replace function public.invoice_org(p_org uuid)
returns public.invoices
language plpgsql security definer set search_path = public
as $$
declare inv public.invoices; org public.organizations; ids uuid[]; n integer; v numeric; tot numeric; first_at timestamptz;
begin
  select * into org from public.organizations where id = p_org for update;
  select array_agg(id) into ids from (
    select id from public.orders where org_id = p_org and billing = 'account' and status = 'delivered' and invoice_id is null for update) x;
  if ids is null then raise exception 'nothing_to_invoice'; end if;
  select count(*), coalesce(sum(vat), 0), coalesce(sum(total - short_credit), 0), min(delivered_at)
    into n, v, tot, first_at
    from public.orders where id = any(ids);
  insert into public.invoices (org_id, period_start, period_end, orders, subtotal, vat, total, due_at)
  values (p_org, first_at::date, current_date, n, tot - v, v, tot, now() + make_interval(days => org.terms_days)) returning * into inv;
  update public.orders set invoice_id = inv.id where id = any(ids);
  perform public.notify(m.id, 'invoice_issued', null, jsonb_build_object('invoice', 'INV-' || inv.invoice_no, 'amount', to_char(tot, 'FM99990.000')))
     from public.profiles m where m.org_id = p_org and m.org_role in ('admin', 'finance');
  return inv;
end $$;

-- ===========================================================================
-- S4 — company drivers and business members join by accepting an invitation
-- ===========================================================================
create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('driver', 'org_member')),
  company_id  uuid references public.companies (id) on delete cascade,
  org_id      uuid references public.organizations (id) on delete cascade,
  org_role    text check (org_role in ('admin', 'site_manager', 'finance')),
  email       text not null,
  invited_by  uuid references public.profiles (id) on delete set null,
  status      text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'revoked')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days',
  decided_at  timestamptz,
  check ((kind = 'driver') = (company_id is not null)),
  check ((kind = 'org_member') = (org_id is not null and org_role is not null))
);
create unique index invitations_one_pending on public.invitations (kind, coalesce(company_id, org_id), lower(email)) where status = 'pending';
alter table public.invitations enable row level security;
revoke all on public.invitations from anon, authenticated;
grant select on public.invitations to authenticated;
create function public.my_email()
returns text language sql stable security definer set search_path = public
as $$ select lower(email) from auth.users where id = auth.uid() $$;
create policy invitations_invitee on public.invitations for select to authenticated using (lower(email) = public.my_email());
create policy invitations_company on public.invitations for select to authenticated using (public.is_owner() and company_id = public.my_company_id());
create policy invitations_org on public.invitations for select to authenticated using (org_id is not null and org_id = public.my_org_id());
create policy invitations_staff on public.invitations for select to authenticated using (public.is_staff());

-- These now send an invitation instead of attaching the account directly.
drop function public.owner_add_driver(text);
create function public.owner_add_driver(p_email text)
returns public.invitations
language plpgsql security definer set search_path = public
as $$
declare i public.invitations;
begin
  if not public.is_owner() then raise exception 'not_an_owner'; end if;
  if char_length(btrim(coalesce(p_email, ''))) < 5 then raise exception 'invalid_value'; end if;
  begin
    insert into public.invitations (kind, company_id, email, invited_by) values ('driver', public.my_company_id(), lower(btrim(p_email)), auth.uid()) returning * into i;
  exception when unique_violation then raise exception 'invitation_pending';
  end;
  return i;
end $$;

drop function public.org_add_member(text, text);
create function public.org_add_member(p_email text, p_role text)
returns public.invitations
language plpgsql security definer set search_path = public
as $$
declare i public.invitations;
begin
  if coalesce(public.my_org_role(), '') <> 'admin' then raise exception 'forbidden_for_role'; end if;
  if p_role not in ('admin', 'site_manager', 'finance') then raise exception 'invalid_role'; end if;
  if lower(btrim(coalesce(p_email, ''))) = public.my_email() then raise exception 'cannot_change_own_role'; end if;
  begin
    insert into public.invitations (kind, org_id, org_role, email, invited_by) values ('org_member', public.my_org_id(), p_role, lower(btrim(p_email)), auth.uid()) returning * into i;
  exception when unique_violation then raise exception 'invitation_pending';
  end;
  return i;
end $$;

create function public.revoke_invitation(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.invitations set status = 'revoked', decided_at = now()
   where id = p_id and status = 'pending'
     and ((kind = 'driver' and public.is_owner() and company_id = public.my_company_id())
          or (kind = 'org_member' and org_id = public.my_org_id() and coalesce(public.my_org_role(), '') = 'admin'));
  if not found then raise exception 'not_found'; end if;
end $$;

-- The invitee accepts (or declines). Their profile is locked and must still be unattached.
create function public.respond_invitation(p_id uuid, p_accept boolean)
returns public.invitations
language plpgsql security definer set search_path = public
as $$
declare i public.invitations; me public.profiles;
begin
  select * into i from public.invitations where id = p_id and lower(email) = public.my_email() and status = 'pending' for update;
  if not found then raise exception 'not_found'; end if;
  if i.expires_at < now() then raise exception 'invitation_expired'; end if;
  if not p_accept then
    update public.invitations set status = 'declined', decided_at = now() where id = i.id returning * into i;
    return i;
  end if;
  select * into me from public.profiles where id = auth.uid() for update;
  if i.kind = 'driver' then
    if me.role <> 'driver' then raise exception 'driver_not_found'; end if;
    if me.company_id is not null and me.company_id <> i.company_id then raise exception 'driver_in_other_company'; end if;
    update public.profiles set company_id = i.company_id where id = me.id;
    -- The driver chose to join: their own unaffiliated tanker joins with them.
    update public.tankers set company_id = i.company_id
     where id = (select tanker_id from public.tanker_assignments where driver_id = me.id and unassigned_at is null) and company_id is null;
  else
    if me.role <> 'business' then raise exception 'user_not_found'; end if;
    if me.org_id is not null and me.org_id <> i.org_id then raise exception 'user_in_other_org'; end if;
    update public.profiles set org_id = i.org_id, org_role = i.org_role where id = me.id;
  end if;
  update public.invitations set status = 'accepted', decided_at = now() where id = i.id returning * into i;
  return i;
end $$;

-- ===========================================================================
-- S3 — private profile fields are readable only by the person (and staff)
-- ===========================================================================
revoke select on public.profiles from authenticated;
grant select (id, role, staff_role, full_name, phone, created_at, company_id, org_id, org_role, id_verified, segment, lang,
              account_blocked, staff_zones) on public.profiles to authenticated;

create function public.my_private_profile()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object('id_type', id_type, 'id_no', id_no, 'id_verified', id_verified, 'prefs', prefs, 'loyalty_points', loyalty_points)
    from public.profiles where id = auth.uid()
$$;

-- Staff: identity and consent fields for many customers at once (CRM, privacy report).
create function public.staff_private_profiles(p_ids uuid[] default null)
returns table (id uuid, id_type text, id_no text, loyalty_points integer, share_usage boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  return query
    select p.id, p.id_type, p.id_no, p.loyalty_points, coalesce((p.prefs ->> 'share_usage')::boolean, false)
      from public.profiles p
     where p.role in ('customer', 'business') and (p_ids is null or p.id = any(p_ids));
end $$;

-- ===========================================================================
-- S2 — evidence files: the uploader, staff, or whoever may see the record that cites them
-- ===========================================================================
do $$
begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists evidence_read on storage.objects';
    execute $p$create policy evidence_read on storage.objects for select to authenticated using (
      bucket_id = 'evidence' and (
        (storage.foldername(name))[1] = auth.uid()::text
        or public.is_staff()
        or exists (select 1 from public.pods d where d.photo_path = storage.objects.name)
        or exists (select 1 from public.complaints c where c.photo_path = storage.objects.name)
        or exists (select 1 from public.tanker_documents t where t.file_path = storage.objects.name)))$p$;
  end if;
end $$;

-- ===========================================================================
-- T4 — the control-room scan runs on a database schedule, not only from open dashboards
-- ===========================================================================
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
      execute $c$select cron.unschedule(jobid) from cron.job where jobname = 'nama-staff-scan'$c$;
      execute $c$select cron.schedule('nama-staff-scan', '* * * * *', 'select public.staff_scan()')$c$;
    exception when others then
      raise notice 'pg_cron not available to this role (%); enable it in the Supabase dashboard and schedule select public.staff_scan() every minute', sqlerrm;
    end;
  end if;
end $$;

-- ===========================================================================
-- Execute rights
-- ===========================================================================
revoke execute on function public.lock_wallet(uuid), public.tanker_company_active(uuid), public.evidence_object_ok(text), public.my_email()
  from public, anon, authenticated;
grant execute on function public.tanker_company_active(uuid), public.my_email() to authenticated;
do $$
declare f text;
begin
  foreach f in array array['owner_add_driver(text)', 'org_add_member(text, text)', 'revoke_invitation(uuid)', 'respond_invitation(uuid, boolean)',
                           'my_private_profile()', 'staff_private_profiles(uuid[])']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
