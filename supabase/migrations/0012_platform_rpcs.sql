-- Platform RPCs. Every write is a SECURITY DEFINER function that checks the
-- caller, validates the transition and (for staff) writes one audit row.
-- Errors use stable machine-readable messages that the UI maps to text.

-- ===========================================================================
-- Internal: settlement, refunds, penalties, alerts
-- ===========================================================================

-- Refund part of an order's payment to the customer's wallet.
create function public.refund_to_wallet(p_order uuid, p_amount numeric, p_kind text, p_memo text)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare o public.orders; pay public.payments; amt numeric := round(coalesce(p_amount, 0), 3);
begin
  if amt <= 0 then return 0; end if;
  select * into o from public.orders where id = p_order;
  if o.customer_id is null or o.billing = 'account' then return 0; end if;
  select * into pay from public.payments where order_id = p_order and status in ('authorized', 'captured', 'partially_refunded') order by created_at desc limit 1;
  if found and pay.method = 'cash' and pay.status = 'authorized' then
    update public.payments set status = 'refunded' where id = pay.id;
    update public.orders set payment_status = 'refunded' where id = p_order;
    return 0;
  end if;
  if found then
    amt := least(amt, pay.amount - pay.refunded_amount);
    if amt <= 0 then return 0; end if;
    update public.payments
       set refunded_amount = refunded_amount + amt,
           status = case when refunded_amount + amt >= amount then 'refunded' else 'partially_refunded' end
     where id = pay.id;
    update public.orders set payment_status = case when pay.refunded_amount + amt >= pay.amount then 'refunded' else 'partially_refunded' end where id = p_order;
  end if;
  insert into public.wallet_tx (customer_id, kind, amount, order_id, memo) values (o.customer_id, p_kind, amt, p_order, p_memo);
  perform public.notify(o.customer_id, 'refund_issued', p_order, jsonb_build_object('order', 'TO-' || o.order_no, 'amount', to_char(amt, 'FM9990.000')));
  return amt;
end $$;

-- A completed job: capture payment, pay the tanker company, award loyalty points.
create function public.settle_order(p_order uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare o public.orders; pts integer; loy jsonb := public.setting_json('LOYALTY');
begin
  select * into o from public.orders where id = p_order;
  update public.payments set status = 'captured', captured_at = now() where order_id = p_order and status = 'authorized';
  update public.orders set payment_status = 'captured' where id = p_order and payment_status = 'authorized';
  if o.tanker_id is not null and public.tanker_company(o.tanker_id) is not null
     and not exists (select 1 from public.company_tx where order_id = p_order and kind = 'earning') then
    insert into public.company_tx (company_id, driver_id, tanker_id, kind, amount, order_id, memo)
    values (public.tanker_company(o.tanker_id), o.driver_id, o.tanker_id, 'earning', o.driver_earnings, p_order, 'TO-' || o.order_no);
  end if;
  if o.billing = 'prepaid' and o.customer_id is not null then
    pts := floor(o.total * coalesce((loy ->> 'points_per_omr')::numeric, 1));
    if pts > 0 then update public.profiles set loyalty_points = loyalty_points + pts where id = o.customer_id; end if;
  end if;
end $$;

-- Issue a penalty from the framework. Fines on tanker companies are deducted from earnings.
create function public.issue_penalty(p_rule text, p_order uuid, p_tanker uuid, p_reason text, p_evidence text default '', p_amount numeric default null)
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
    insert into public.wallet_tx (customer_id, kind, amount, order_id, memo) values (p.customer_id, 'cancel_fee', -amt, p_order, rule.label);
  end if;
  return p;
end $$;

create function public.raise_alert(p_tanker uuid, p_order uuid, p_type text, p_severity text, p_message text, p_lat double precision, p_lng double precision, p_dedupe text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.alerts (tanker_id, order_id, type, severity, message, lat, lng, dedupe_key)
  values (p_tanker, p_order, p_type, p_severity, p_message, p_lat, p_lng, p_dedupe)
  on conflict (dedupe_key) where state <> 'resolved' and dedupe_key is not null do nothing;
end $$;

-- Scheduled orders become open requests 90 minutes before their slot.
create function public.release_due_orders()
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  update public.orders set status = 'requested', released_at = now()
   where status = 'scheduled' and slot_start <= now() + interval '90 minutes';
  get diagnostics n = row_count;
  return n;
end $$;

-- ===========================================================================
-- Customer
-- ===========================================================================
create function public.my_wallet()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'balance', public.wallet_balance(auth.uid()),
    'points', (select loyalty_points from public.profiles where id = auth.uid()),
    'loyalty', public.setting_json('LOYALTY'))
$$;

create function public.quote_order(p_service_type public.service_type, p_gallons integer, p_slot_start timestamptz default null,
                                   p_emergency boolean default false, p_promo_code text default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare q record; pct numeric := 0; promo public.promotions;
begin
  if p_gallons is null or p_gallons < 1 or p_gallons > 20000 then raise exception 'invalid_gallons'; end if;
  if nullif(btrim(coalesce(p_promo_code, '')), '') is not null then
    select * into promo from public.promotions where code = upper(btrim(p_promo_code)) and active and uses < max_uses and (valid_to is null or valid_to >= current_date)
       and (audience in ('all', 'household')
            or (audience = 'new' and not exists (select 1 from public.orders where customer_id = auth.uid() and status = 'delivered')));
    if not found then raise exception 'invalid_promo'; end if;
    pct := promo.pct;
  end if;
  select * into q from public.price_quote_ext(p_service_type, p_gallons, public.is_peak(p_slot_start), coalesce(p_emergency, false), pct);
  return to_jsonb(q) || jsonb_build_object('peak', public.is_peak(p_slot_start), 'priority', coalesce(p_emergency, false), 'discount_pct', pct,
                                           'promo_label', promo.label);
end $$;

-- The full customer checkout: zone check, scheduling, price, promotion and payment.
-- A declined card leaves the order cancelled with payment_status = 'failed'.
create function public.create_order(
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

  if promo is not null then
    if not exists (select 1 from public.promotions where code = promo and active and uses < max_uses and (valid_to is null or valid_to >= current_date)
                     and (audience in ('all', 'household')
                          or (audience = 'new' and not exists (select 1 from public.orders where customer_id = auth.uid() and status = 'delivered')))) then
      raise exception 'invalid_promo';
    end if;
  end if;

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
    return o;
  end if;

  if w > 0 then
    insert into public.wallet_tx (customer_id, kind, amount, order_id, memo) values (auth.uid(), 'payment', -w, o.id, 'TO-' || o.order_no);
  end if;
  insert into public.payments (order_id, customer_id, method, amount, wallet_amount, card_amount, card_last4, status, gateway_ref)
  values (o.id, auth.uid(), p_pay_method, o.total, w, c, case when c > 0 then coalesce(p_card_last4, '4417') end, 'authorized', 'SIM-' || o.order_no);
  if promo is not null then update public.promotions set uses = uses + 1 where code = promo; end if;
  update public.orders set payment_status = 'authorized' where id = o.id returning * into o;
  if o.status = 'requested' then
    perform public.notify(auth.uid(), 'order_confirmed', o.id, jsonb_build_object('order', 'TO-' || o.order_no, 'total', to_char(o.total, 'FM9990.000')));
  end if;
  return o;
end $$;

-- Free cancellation before a tanker is assigned (as before); scheduled and
-- awaiting-approval orders can be cancelled too. Any payment is refunded.
create or replace function public.cancel_order(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders;
begin
  update public.orders
     set status = 'cancelled', cancelled_at = now(), cancelled_by = 'customer'
   where id = p_order_id
     and customer_id = auth.uid()
     and status in ('requested', 'scheduled', 'pending_approval')
  returning * into o;

  if not found then
    if exists (select 1 from public.orders where id = p_order_id and customer_id = auth.uid()) then
      raise exception 'cannot_cancel';
    end if;
    raise exception 'not_found';
  end if;
  perform public.refund_to_wallet(o.id, o.total, 'refund', 'Cancelled TO-' || o.order_no);
  select * into o from public.orders where id = o.id;
  return o;
end $$;

-- Cancel after a tanker is assigned (before it arrives): the cancellation fee
-- is kept and goes to the tanker company; the rest is refunded to the wallet.
create function public.cancel_order_with_fee(p_order_id uuid, p_reason text default null)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; fee numeric := public.rule_num('cancel_fee_omr'); co uuid;
begin
  select * into o from public.orders where id = p_order_id and customer_id = auth.uid() for update;
  if not found then raise exception 'not_found'; end if;
  if o.status in ('requested', 'scheduled', 'pending_approval') then return public.cancel_order(p_order_id); end if;
  if o.status not in ('accepted', 'arriving') then raise exception 'cannot_cancel'; end if;
  fee := least(fee, o.total);
  co := public.tanker_company(o.tanker_id);
  update public.orders
     set status = 'cancelled', cancelled_at = now(), cancelled_by = 'customer', cancel_fee = fee,
         cancel_reason = nullif(left(btrim(coalesce(p_reason, '')), 300), '')
   where id = o.id returning * into o;
  if co is not null and fee > 0 then
    insert into public.company_tx (company_id, driver_id, tanker_id, kind, amount, order_id, memo)
    values (co, o.driver_id, o.tanker_id, 'cancel_fee', round(fee * public.rule_num('driver_share'), 3), o.id, 'Customer cancelled TO-' || o.order_no);
  end if;
  perform public.refund_to_wallet(o.id, o.total - fee, 'refund', 'Cancelled TO-' || o.order_no || ' (fee ' || to_char(fee, 'FM9990.000') || ')');
  select * into o from public.orders where id = o.id;
  return o;
end $$;

create function public.reschedule_order(p_order_id uuid, p_slot_start timestamptz, p_slot_end timestamptz, p_slot_label text)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders;
begin
  if p_slot_start is null or p_slot_end is null or p_slot_end <= p_slot_start or p_slot_end < now() then raise exception 'invalid_slot'; end if;
  update public.orders
     set slot_start = p_slot_start, slot_end = p_slot_end, slot_label = left(p_slot_label, 60),
         status = case when p_slot_start > now() + interval '2 hours' then 'scheduled'::public.order_status else 'requested'::public.order_status end
   where id = p_order_id and customer_id = auth.uid() and status in ('scheduled', 'requested')
  returning * into o;
  if not found then raise exception 'cannot_reschedule'; end if;
  return o;
end $$;

create function public.rate_order(p_order_id uuid, p_rating integer, p_comment text default null, p_tip numeric default 0, p_tip_method text default 'wallet')
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; v_tip numeric := round(coalesce(p_tip, 0), 3); co uuid;
begin
  if p_rating is null or p_rating < 1 or p_rating > 5 then raise exception 'invalid_rating'; end if;
  if v_tip < 0 or v_tip > 20 then raise exception 'invalid_tip'; end if;
  select * into o from public.orders where id = p_order_id and customer_id = auth.uid() for update;
  if not found then raise exception 'not_found'; end if;
  if o.status <> 'delivered' then raise exception 'not_delivered'; end if;
  if o.rated_at is not null then raise exception 'already_rated'; end if;
  if v_tip > 0 then
    if p_tip_method = 'wallet' then
      if public.wallet_balance(auth.uid()) < v_tip then raise exception 'insufficient_wallet'; end if;
      insert into public.wallet_tx (customer_id, kind, amount, order_id, memo) values (auth.uid(), 'tip', -v_tip, o.id, 'Tip for TO-' || o.order_no);
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
  -- Company rating = average of its rated jobs.
  if public.tanker_company(o.tanker_id) is not null then
    update public.companies c
       set rating = coalesce((select round(avg(x.rating)::numeric, 1) from public.orders x join public.tankers t on t.id = x.tanker_id
                              where t.company_id = c.id and x.rating is not null), c.rating)
     where c.id = public.tanker_company(o.tanker_id);
  end if;
  return o;
end $$;

create function public.wallet_topup(p_amount numeric, p_method text default 'card', p_card_last4 text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare amt numeric := round(coalesce(p_amount, 0), 3);
begin
  if public.my_role() is distinct from 'customer' then raise exception 'not_a_customer'; end if;
  if amt < 1 or amt > 500 then raise exception 'invalid_amount'; end if;
  if p_method not in ('card', 'omannet') then raise exception 'invalid_payment_method'; end if;
  if coalesce(p_card_last4, '') = '0002' then raise exception 'payment_failed'; end if;
  insert into public.wallet_tx (customer_id, kind, amount, memo)
  values (auth.uid(), 'topup', amt, case when p_method = 'omannet' then 'OmanNet top-up' else 'Card top-up ••' || coalesce(p_card_last4, '4417') end);
  return public.my_wallet();
end $$;

create function public.redeem_points()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare loy jsonb := public.setting_json('LOYALTY'); need integer; per numeric; pts integer; units integer;
begin
  need := coalesce((loy ->> 'redeem_points')::integer, 100);
  per := coalesce((loy ->> 'redeem_omr')::numeric, 1);
  select loyalty_points into pts from public.profiles where id = auth.uid() and role = 'customer' for update;
  if pts is null then raise exception 'not_a_customer'; end if;
  units := pts / need;
  if units < 1 then raise exception 'not_enough_points'; end if;
  update public.profiles set loyalty_points = loyalty_points - units * need where id = auth.uid();
  insert into public.wallet_tx (customer_id, kind, amount, memo) values (auth.uid(), 'loyalty', units * per, (units * need) || ' points redeemed');
  return public.my_wallet();
end $$;

create function public.add_payment_method(p_brand text, p_last4 text)
returns public.payment_methods
language plpgsql security definer set search_path = public
as $$
declare m public.payment_methods;
begin
  if public.my_role() is distinct from 'customer' then raise exception 'not_a_customer'; end if;
  if p_last4 !~ '^[0-9]{4}$' then raise exception 'invalid_card'; end if;
  insert into public.payment_methods (customer_id, brand, last4, is_default)
  values (auth.uid(), p_brand, p_last4, not exists (select 1 from public.payment_methods where customer_id = auth.uid()))
  returning * into m;
  return m;
end $$;

create function public.remove_payment_method(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  delete from public.payment_methods where id = p_id and customer_id = auth.uid();
  if not found then raise exception 'not_found'; end if;
end $$;

create function public.save_property(p_id uuid, p_label text, p_address text, p_area text, p_lat double precision, p_lng double precision, p_tank_gal integer)
returns public.properties
language plpgsql security definer set search_path = public
as $$
declare p public.properties; org uuid := public.my_org_id(); r public.user_role := public.my_role();
begin
  if r = 'customer' then org := null;
  elsif r = 'business' then
    if coalesce(public.my_org_role(), '') not in ('admin', 'site_manager') then raise exception 'forbidden_for_role'; end if;
  else raise exception 'forbidden_for_role'; end if;
  if p_lat is null or p_lng is null then raise exception 'invalid_location'; end if;
  if p_id is null then
    insert into public.properties (customer_id, org_id, label, address, area, lat, lng, tank_gal)
    values (case when org is null then auth.uid() end, org, btrim(p_label), coalesce(p_address, ''), coalesce(p_area, ''), p_lat, p_lng, coalesce(p_tank_gal, 3000))
    returning * into p;
  else
    update public.properties
       set label = btrim(p_label), address = coalesce(p_address, ''), area = coalesce(p_area, ''), lat = p_lat, lng = p_lng, tank_gal = coalesce(p_tank_gal, tank_gal)
     where id = p_id and ((org is null and customer_id = auth.uid()) or (org is not null and org_id = org))
    returning * into p;
    if not found then raise exception 'not_found'; end if;
  end if;
  return p;
end $$;

create function public.delete_property(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if exists (select 1 from public.contracts where property_id = p_id and status in ('pending_owner', 'active', 'paused')) then raise exception 'property_has_contract'; end if;
  delete from public.properties where id = p_id and (customer_id = auth.uid() or (org_id = public.my_org_id() and public.my_org_role() in ('admin', 'site_manager')));
  if not found then raise exception 'not_found'; end if;
end $$;

create function public.verify_identity(p_id_type text, p_id_no text)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare p public.profiles;
begin
  if p_id_type not in ('civil_id', 'resident_card', 'passport') then raise exception 'invalid_id_type'; end if;
  -- Simulated national ID check: 8 digits for Civil ID / Resident card.
  if p_id_type in ('civil_id', 'resident_card') and p_id_no !~ '^[0-9]{8}$' then raise exception 'id_not_verified'; end if;
  update public.profiles set id_type = p_id_type, id_no = btrim(p_id_no), id_verified = true where id = auth.uid() returning * into p;
  return p;
end $$;

create function public.file_complaint(p_order_id uuid, p_category text, p_description text, p_photo_path text default null)
returns public.complaints
language plpgsql security definer set search_path = public
as $$
declare s public.complaint_sla; c public.complaints; r public.user_role := public.my_role();
begin
  if r not in ('customer', 'business') then raise exception 'forbidden_for_role'; end if;
  select * into s from public.complaint_sla where category = p_category;
  if not found then raise exception 'invalid_category'; end if;
  if p_order_id is not null and not public.can_see_order(p_order_id) then raise exception 'not_found'; end if;
  insert into public.complaints (order_id, customer_id, category, description, photo_path, channel, owner_team, sla_hours, due_at)
  values (p_order_id, auth.uid(), p_category, btrim(p_description), p_photo_path, case when r = 'business' then 'business' else 'app' end,
          s.team, s.hours, now() + make_interval(hours => s.hours))
  returning * into c;
  insert into public.complaint_notes (complaint_id, author_id, author_role, body) values (c.id, auth.uid(), r::text, btrim(p_description));
  perform public.notify(auth.uid(), 'complaint_update', p_order_id, jsonb_build_object('case', 'C-' || c.case_no, 'status', 'received', 'status_ar', 'قيد المراجعة'));
  return c;
end $$;

create function public.complaint_reply(p_complaint_id uuid, p_body text)
returns public.complaint_notes
language plpgsql security definer set search_path = public
as $$
declare n public.complaint_notes;
begin
  if not exists (select 1 from public.complaints where id = p_complaint_id and customer_id = auth.uid()) then raise exception 'not_found'; end if;
  insert into public.complaint_notes (complaint_id, author_id, author_role, body) values (p_complaint_id, auth.uid(), 'customer', btrim(p_body)) returning * into n;
  return n;
end $$;

create function public.send_message(p_order_id uuid, p_body text)
returns public.order_messages
language plpgsql security definer set search_path = public
as $$
declare o public.orders; m public.order_messages; who text;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then raise exception 'not_found'; end if;
  if o.customer_id = auth.uid() then who := 'customer';
  elsif o.driver_id = auth.uid() then who := 'driver';
  elsif public.is_staff() then who := 'staff';
  else raise exception 'not_found'; end if;
  if who <> 'staff' and o.status not in ('accepted', 'arriving', 'arrived', 'collected') then raise exception 'chat_closed'; end if;
  insert into public.order_messages (order_id, sender_id, sender_role, body) values (o.id, auth.uid(), who, btrim(p_body)) returning * into m;
  return m;
end $$;

create function public.mark_notifications_read(p_ids bigint[] default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  update public.notifications set read_at = now()
   where user_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids));
  get diagnostics n = row_count;
  return n;
end $$;

-- Verification card shown to the customer for the tanker serving their order.
create function public.order_verification(p_order_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare o public.orders; res jsonb;
begin
  select * into o from public.orders where id = p_order_id;
  if not found or not (public.can_see_order(p_order_id) or public.is_staff()) then raise exception 'not_found'; end if;
  if o.tanker_id is null then return null; end if;
  select jsonb_build_object(
    'company', (select name from public.companies where id = t.company_id),
    'company_rating', (select rating from public.companies where id = t.company_id),
    'permit_no', p.permit_no, 'permit_valid_to', p.expires_at,
    'licence_valid_to', (select max(valid_to) from public.tanker_documents d where d.driver_id = o.driver_id and d.kind = 'heavy_licence' and d.status = 'valid'),
    'tank_cleaned', (select max(valid_to) from public.tanker_documents d where d.tanker_id = t.id and d.kind = 'tank_cleanliness' and d.status = 'valid'),
    'water_test', (select jsonb_build_object('cert_no', w.cert_no, 'tested_at', w.tested_at, 'passed', w.passed, 'chlorine', w.chlorine, 'turbidity', w.turbidity,
                                             'tds', w.tds, 'ph', w.ph, 'ecoli', w.ecoli, 'coliforms', w.coliforms)
                     from public.water_tests w where w.tanker_id = t.id order by w.tested_at desc limit 1),
    'device', (select id from public.devices where tanker_id = t.id),
    'capacity_gal', t.capacity_gal, 'plate', t.plate)
    into res
    from public.tankers t
    left join lateral (select * from public.permits x where x.tanker_id = t.id and x.status = 'approved' order by x.expires_at desc limit 1) p on true
   where t.id = o.tanker_id;
  return res;
end $$;

create function public.file_data_request(p_kind text, p_details text default '')
returns public.data_requests
language plpgsql security definer set search_path = public
as $$
declare d public.data_requests;
begin
  if p_kind not in ('access', 'delete', 'correct') then raise exception 'invalid_kind'; end if;
  if exists (select 1 from public.data_requests where customer_id = auth.uid() and kind = p_kind and state = 'open') then raise exception 'request_already_open'; end if;
  insert into public.data_requests (customer_id, kind, details) values (auth.uid(), p_kind, coalesce(p_details, '')) returning * into d;
  return d;
end $$;

-- ===========================================================================
-- Contracts (households and businesses)
-- ===========================================================================
create function public.create_contract(p_property_id uuid, p_company_id uuid, p_service_type public.service_type, p_gallons integer,
                                       p_frequency text, p_plan text, p_slot text, p_start_date date, p_months integer)
returns public.contracts
language plpgsql security definer set search_path = public
as $$
declare prop public.properties; c public.contracts; per_month numeric; q record; r public.user_role := public.my_role();
begin
  select * into prop from public.properties where id = p_property_id
     and ((r = 'customer' and customer_id = auth.uid()) or (r = 'business' and org_id = public.my_org_id() and public.my_org_role() in ('admin', 'site_manager')));
  if not found then raise exception 'not_found'; end if;
  if not exists (select 1 from public.companies where id = p_company_id and status = 'active') then raise exception 'company_unavailable'; end if;
  if p_frequency not in ('weekly', 'biweekly', 'monthly') or p_plan not in ('monthly', 'yearly') or p_slot not in ('morning', 'evening') then raise exception 'invalid_contract'; end if;
  if p_months is null or p_months < 1 or p_months > 24 then raise exception 'invalid_contract'; end if;
  if p_start_date is null or p_start_date < current_date then raise exception 'invalid_contract'; end if;
  select * into q from public.price_quote_ext(p_service_type, p_gallons, p_slot = 'evening', false,
                                              public.rule_num(case p_plan when 'yearly' then 'discount_yearly' else 'discount_monthly' end));
  per_month := round(q.total * case p_frequency when 'weekly' then 4.33 when 'biweekly' then 2.17 else 1 end, 3);
  insert into public.contracts (customer_id, org_id, property_id, company_id, service_type, gallons, frequency, plan, slot, start_date, end_date, monthly_est)
  values (case when r = 'customer' then auth.uid() end, prop.org_id, prop.id, p_company_id, p_service_type, p_gallons, p_frequency, p_plan, p_slot,
          p_start_date, (p_start_date + make_interval(months => p_months))::date, per_month)
  returning * into c;
  perform public.notify(m.id, 'contract_offer', null, jsonb_build_object('contract', 'CT-' || c.contract_no, 'area', prop.area))
     from public.profiles m where m.company_id = p_company_id and m.role = 'owner';
  return c;
end $$;

create function public.contract_set_status(p_contract_id uuid, p_action text)
returns public.contracts
language plpgsql security definer set search_path = public
as $$
declare c public.contracts;
begin
  select * into c from public.contracts where id = p_contract_id
     and (customer_id = auth.uid() or (org_id = public.my_org_id() and public.my_org_role() in ('admin', 'site_manager'))) for update;
  if not found then raise exception 'not_found'; end if;
  if p_action = 'pause' and c.status = 'active' then update public.contracts set status = 'paused' where id = c.id returning * into c;
  elsif p_action = 'resume' and c.status = 'paused' then update public.contracts set status = 'active' where id = c.id returning * into c;
  elsif p_action = 'end' and c.status in ('pending_owner', 'active', 'paused') then
    update public.contracts set status = 'ended', end_date = greatest(current_date, start_date + 1) where id = c.id returning * into c;
    update public.orders set status = 'cancelled', cancelled_at = now(), cancelled_by = 'customer', cancel_reason = 'Contract ended'
     where contract_id = c.id and status = 'scheduled';
  else raise exception 'invalid_transition'; end if;
  return c;
end $$;

-- Creates the scheduled orders of active contracts for the next 7 days (idempotent).
create function public.generate_contract_orders()
returns integer
language plpgsql security definer set search_path = public
as $$
declare c record; d date; n integer := 0; step interval; s timestamptz; o public.orders;
begin
  for c in select k.*, p.lat, p.lng, p.area, p.address from public.contracts k join public.properties p on p.id = k.property_id
            where k.status = 'active' and k.end_date >= current_date loop
    step := case c.frequency when 'weekly' then interval '7 days' when 'biweekly' then interval '14 days' else interval '1 month' end;
    d := c.start_date;
    while d < current_date loop d := (d + step)::date; end loop;
    while d <= current_date + 7 and d < c.end_date loop
      s := (d + case c.slot when 'evening' then time '18:00' else time '08:00' end) at time zone 'Asia/Muscat';
      if s > now() and not exists (select 1 from public.orders where contract_id = c.id and slot_start = s)
         and (c.customer_id is not null or exists (select 1 from public.profiles where org_id = c.org_id and org_role = 'admin')) then
        insert into public.orders (customer_id, org_id, service_type, gallons, area, property_id, contract_id, zone_id, status, slot_start, slot_end, slot_label,
                                   slot_peak, channel, billing, pay_method, payment_status)
        -- Business contracts are booked under the account admin.
        values (coalesce(c.customer_id, (select id from public.profiles where org_id = c.org_id and org_role = 'admin' order by created_at limit 1)),
                c.org_id, c.service_type, c.gallons, coalesce(nullif(c.area, ''), 'Contract delivery'), c.property_id, c.id,
                (public.zone_at(c.lat, c.lng, true)).id, 'scheduled', s, s + interval '2 hours',
                to_char(d, 'Dy DD Mon') || case c.slot when 'evening' then ' · 6–8 pm' else ' · 8–10 am' end,
                c.slot = 'evening', 'contract', 'account', 'account', 'on_account')
        returning * into o;
        insert into public.order_locations (order_id, lat, lng, address) values (o.id, c.lat, c.lng, coalesce(c.address, ''));
        n := n + 1;
      end if;
      d := (d + step)::date;
    end loop;
  end loop;
  return n;
end $$;

-- ===========================================================================
-- Driver
-- ===========================================================================
create function public.submit_shift_check(p_items jsonb)
returns public.shift_checks
language plpgsql security definer set search_path = public
as $$
declare s public.shift_checks; k text;
begin
  if public.my_role() is distinct from 'driver' then raise exception 'not_a_driver'; end if;
  foreach k in array array['tyres_brakes_lights', 'valves_sealed', 'hatch_locked', 'ppe', 'hose_sanitised'] loop
    if coalesce((p_items ->> k)::boolean, false) is not true then raise exception 'check_incomplete: %', k; end if;
  end loop;
  insert into public.shift_checks (driver_id, tanker_id, day, items)
  values (auth.uid(), public.my_tanker_id(), (now() at time zone 'Asia/Muscat')::date, p_items)
  on conflict (driver_id, day) do update set items = excluded.items, created_at = now()
  returning * into s;
  return s;
end $$;

create function public.set_availability(p_weekday integer, p_available boolean, p_shift text default 'day', p_driver_id uuid default null)
returns public.driver_availability
language plpgsql security definer set search_path = public
as $$
declare a public.driver_availability; target uuid := coalesce(p_driver_id, auth.uid());
begin
  if target = auth.uid() then
    if public.my_role() is distinct from 'driver' then raise exception 'not_a_driver'; end if;
  elsif not (public.is_owner() and exists (select 1 from public.profiles where id = target and role = 'driver' and company_id = public.my_company_id())) then
    raise exception 'not_found';
  end if;
  insert into public.driver_availability (driver_id, weekday, available, shift) values (target, p_weekday, p_available, coalesce(p_shift, 'day'))
  on conflict (driver_id, weekday) do update set available = excluded.available, shift = excluded.shift
  returning * into a;
  return a;
end $$;

-- Open requests matching the caller's tanker. Emergency first, then nearest.
-- Contract jobs are offered only to the contracted company's tankers.
drop function public.open_requests_near(double precision, double precision);
create function public.open_requests_near(p_lat double precision, p_lng double precision)
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
  if not t.is_online or t.blocked or not public.tanker_has_valid_permit(t.id) then return; end if;

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
       and (o.contract_id is null or k.company_id = t.company_id)
     order by o.is_emergency desc, 6, o.created_at
     limit 50;
end $$;

-- Upcoming scheduled jobs the driver could take later (contract jobs of their company first).
create function public.driver_scheduled_jobs()
returns table (id uuid, order_no bigint, service_type public.service_type, gallons integer, area text, slot_label text, slot_start timestamptz,
               driver_earnings numeric(10,3), contract_no bigint)
language plpgsql stable security definer set search_path = public
as $$
declare t public.tankers;
begin
  t := public.my_tanker();
  return query
    select o.id, o.order_no, o.service_type, o.gallons, o.area, o.slot_label, o.slot_start, o.driver_earnings, k.contract_no
      from public.orders o left join public.contracts k on k.id = o.contract_id
     where o.status = 'scheduled' and o.service_type = t.service_type and o.gallons <= t.capacity_gal
       and (o.contract_id is null or k.company_id = t.company_id)
     order by (o.contract_id is not null) desc, o.slot_start
     limit 50;
end $$;

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
  if t.blocked then raise exception 'tanker_blocked: %', coalesce(t.blocked_reason, 'blocked by NWS'); end if;
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
       and (contract_id is null or exists (select 1 from public.contracts k where k.id = contract_id and k.company_id = t.company_id))
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

-- GPS fix: as before, plus GPS history, speed and the control-room rules
-- (speeding, outside the service area).
create or replace function public.report_location(
  p_lat         double precision,
  p_lng         double precision,
  p_accuracy_m  double precision,
  p_recorded_at timestamptz
)
returns void
language plpgsql security definer set search_path = public
as $$
declare t public.tankers; prev public.gps_fixes; spd numeric; job uuid;
begin
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then
    raise exception 'invalid_location';
  end if;
  if p_accuracy_m is null or p_accuracy_m < 0 then
    raise exception 'accuracy_required';
  end if;
  if p_accuracy_m > 100 then
    raise exception 'inaccurate_fix: accuracy % m is worse than 100 m', round(p_accuracy_m::numeric, 1);
  end if;
  if p_recorded_at is null or p_recorded_at < now() - interval '2 minutes' or p_recorded_at > now() + interval '5 minutes' then
    raise exception 'stale_fix';
  end if;

  t := public.my_tanker();
  if t.last_fix_at is not null and p_recorded_at <= t.last_fix_at then
    return; -- older than what we already have
  end if;

  update public.tankers
     set last_lat = p_lat, last_lng = p_lng, last_accuracy_m = p_accuracy_m,
         last_fix_at = p_recorded_at, last_seen_at = now()
   where id = t.id;

  update public.orders
     set status = 'arriving', arriving_at = now()
   where tanker_id = t.id and driver_id = auth.uid() and status = 'accepted';

  select id into job from public.orders where tanker_id = t.id and status in ('accepted', 'arriving', 'arrived', 'collected') limit 1;
  select * into prev from public.gps_fixes where tanker_id = t.id order by recorded_at desc limit 1;
  if prev.id is not null and p_recorded_at > prev.recorded_at then
    spd := round((public.km(prev.lat, prev.lng, p_lat, p_lng) / greatest(extract(epoch from p_recorded_at - prev.recorded_at), 1) * 3600)::numeric, 1);
  end if;
  insert into public.gps_fixes (tanker_id, order_id, lat, lng, accuracy_m, speed_kmh, recorded_at)
  values (t.id, job, p_lat, p_lng, p_accuracy_m, spd, p_recorded_at);

  if spd is not null and spd > 100 and spd < 250 then
    perform public.raise_alert(t.id, job, 'Speeding', 'med', format('%s at %s km/h (limit 100 for heavy vehicles)', t.plate, spd), p_lat, p_lng,
                               'speed:' || t.id || ':' || to_char(now(), 'YYYYMMDDHH24'));
  end if;
  if exists (select 1 from public.zones) and (public.zone_at(p_lat, p_lng, true)).id is null then
    perform public.raise_alert(t.id, job, 'Off-premise / outside service area', 'low', format('%s is outside every NWS service area', t.plate), p_lat, p_lng,
                               'offarea:' || t.id || ':' || to_char(now(), 'YYYYMMDDHH24'));
  end if;
end $$;

-- Station event when a DW/TE tanker fills. Verified when the tanker's last fix
-- is inside the geofence of an active filling station for its service.
create function public.confirm_fill(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; t public.tankers; s public.sites; d double precision; ok boolean; co uuid;
begin
  t := public.my_tanker();
  select * into o from public.orders where id = p_order_id and driver_id = auth.uid() and tanker_id = t.id for update;
  if not found then raise exception 'not_found'; end if;
  if o.service_type = 'WW' then raise exception 'no_fill_for_wastewater'; end if;
  if o.status not in ('accepted', 'arriving') then raise exception 'invalid_transition'; end if;
  if o.filled_at is not null then raise exception 'already_filled'; end if;
  select x.* into s from public.sites x where x.kind = 'fill' and x.active and o.service_type = any(x.service_types)
   order by public.km(coalesce(t.last_lat, 0), coalesce(t.last_lng, 0), x.lat, x.lng) limit 1;
  if s.id is null then raise exception 'no_fill_station'; end if;
  d := case when t.last_lat is null then null else public.km(t.last_lat, t.last_lng, s.lat, s.lng) * 1000 end;
  ok := d is not null and d <= s.radius_m and t.last_fix_at > now() - interval '5 minutes';
  insert into public.source_events (order_id, tanker_id, source, kind, site_id, meter_gal, lat, lng, verified, note)
  values (o.id, t.id, 'tfs', 'fill', s.id, o.gallons, t.last_lat, t.last_lng, ok,
          case when ok then 'Station meter matches order volume' else format('Tanker %s m from %s geofence (radius %s m)', coalesce(round(d)::text, 'unknown'), s.name, s.radius_m) end);
  update public.orders set filled_at = now(), fill_site_id = s.id, fill_meter_gal = o.gallons, fill_verified = ok where id = o.id returning * into o;
  co := t.company_id;
  if co is not null then
    insert into public.company_tx (company_id, driver_id, tanker_id, bucket, kind, amount, order_id, memo)
    values (co, auth.uid(), t.id, 'fill_credit', 'fill_charge', -o.water_charge, o.id, 'Filling at ' || s.name || ' for TO-' || o.order_no);
  end if;
  if not ok then
    perform public.raise_alert(t.id, o.id, 'Filling outside designated station', 'med',
                               format('%s confirmed filling for TO-%s outside %s geofence', t.plate, o.order_no, s.name), t.last_lat, t.last_lng, 'fill:' || o.id);
  end if;
  return o;
end $$;

-- Proof of delivery (DW/TE: completes the job) or of collection (WW: next, discharge).
create function public.submit_pod(p_order_id uuid, p_meter_gal integer, p_photo_path text default null, p_photo_hash text default null,
                                  p_signature_svg text default null, p_no_signature boolean default false, p_left_at_tank boolean default false,
                                  p_lat double precision default null, p_lng double precision default null)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; t public.tankers;
begin
  t := public.my_tanker();
  select * into o from public.orders where id = p_order_id and driver_id = auth.uid() for update;
  if not found then raise exception 'not_found'; end if;
  if o.status <> 'arrived' then raise exception 'invalid_transition'; end if;
  if p_meter_gal is null or p_meter_gal < 0 or p_meter_gal > 20000 then raise exception 'invalid_meter'; end if;
  if coalesce(p_signature_svg, '') = '' and not coalesce(p_no_signature, false) then raise exception 'signature_required'; end if;
  if p_photo_path is null and p_photo_hash is null then raise exception 'photo_required'; end if;
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
  end if;
  return o;
end $$;

-- Wastewater: discharge at a treatment plant. Verified inside an active discharge geofence.
create function public.confirm_discharge(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; t public.tankers; s public.sites; d double precision; ok boolean;
begin
  t := public.my_tanker();
  select * into o from public.orders where id = p_order_id and driver_id = auth.uid() for update;
  if not found then raise exception 'not_found'; end if;
  if o.status <> 'collected' then raise exception 'invalid_transition'; end if;
  select x.* into s from public.sites x where x.kind = 'discharge' and x.active and o.service_type = any(x.service_types)
   order by public.km(coalesce(t.last_lat, 0), coalesce(t.last_lng, 0), x.lat, x.lng) limit 1;
  if s.id is null then raise exception 'no_discharge_site'; end if;
  d := case when t.last_lat is null then null else public.km(t.last_lat, t.last_lng, s.lat, s.lng) * 1000 end;
  ok := d is not null and d <= s.radius_m and t.last_fix_at > now() - interval '5 minutes';
  insert into public.source_events (order_id, tanker_id, source, kind, site_id, meter_gal, lat, lng, verified, note)
  values (o.id, t.id, 'stp', 'discharge', s.id, o.gallons, t.last_lat, t.last_lng, ok,
          case when ok then 'Valve opened inside geofence' else format('Valve opened %s m from %s (radius %s m)', coalesce(round(d)::text, 'unknown'), s.name, s.radius_m) end);
  update public.orders set status = 'delivered', delivered_at = now(), discharged_at = now(), discharge_site_id = s.id, discharge_verified = ok
   where id = o.id returning * into o;
  perform public.settle_order(o.id);
  select * into o from public.orders where id = o.id;
  if not ok then
    perform public.raise_alert(t.id, o.id, 'Discharge outside approved zone', 'high',
                               format('%s discharged TO-%s outside %s geofence', t.plate, o.order_no, s.name), t.last_lat, t.last_lng, 'discharge:' || o.id);
    perform public.issue_penalty('discharge_outside', o.id, t.id, 'Discharge outside approved geofence', 'IVMS valve sensor + GPS');
  end if;
  return o;
end $$;

-- Legacy single-step completion stays available (POD-less), and now settles too.
create or replace function public.mark_delivered(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders;
begin
  update public.orders
     set status = 'delivered', delivered_at = now()
   where id = p_order_id
     and driver_id = auth.uid()
     and status = 'arrived'
  returning * into o;
  if not found then raise exception 'invalid_transition'; end if;
  perform public.settle_order(o.id);
  select * into o from public.orders where id = o.id;
  return o;
end $$;

-- Report a problem. Breakdown / accident / station closed release the job back to dispatch.
create function public.report_trip_issue(p_order_id uuid, p_kind text, p_note text default '')
returns public.trip_issues
language plpgsql security definer set search_path = public
as $$
declare o public.orders; t public.tankers; i public.trip_issues; rel boolean;
begin
  t := public.my_tanker();
  select * into o from public.orders where id = p_order_id and driver_id = auth.uid() for update;
  if not found then raise exception 'not_found'; end if;
  if o.status not in ('accepted', 'arriving', 'arrived', 'collected') then raise exception 'invalid_transition'; end if;
  if p_kind not in ('breakdown', 'customer_unreachable', 'wrong_address', 'station_closed', 'accident') then raise exception 'invalid_kind'; end if;
  -- A collected load can't go back to dispatch: control handles it from the alert.
  rel := p_kind in ('breakdown', 'accident', 'station_closed') and o.status <> 'collected';
  insert into public.trip_issues (order_id, driver_id, tanker_id, kind, note, released)
  values (o.id, auth.uid(), t.id, p_kind, coalesce(left(p_note, 500), ''), rel) returning * into i;
  perform public.raise_alert(t.id, o.id,
    case p_kind when 'accident' then 'Accident reported' when 'breakdown' then 'Vehicle breakdown' when 'station_closed' then 'Station closed or no water'
                when 'customer_unreachable' then 'Customer not reachable' else 'Wrong address' end,
    case when p_kind = 'accident' then 'high' when rel then 'med' else 'low' end,
    format('%s on TO-%s: %s', t.plate, o.order_no, coalesce(nullif(btrim(p_note), ''), replace(p_kind, '_', ' '))), t.last_lat, t.last_lng, 'issue:' || i.id);
  if rel then
    if o.filled_at is not null and t.company_id is not null then
      insert into public.company_tx (company_id, driver_id, tanker_id, bucket, kind, amount, order_id, memo)
      values (t.company_id, auth.uid(), t.id, 'fill_credit', 'fill_charge', o.water_charge, o.id, 'Filling refunded: TO-' || o.order_no || ' released');
    end if;
    update public.orders
       set status = 'requested', driver_id = null, tanker_id = null, driver_name = null, tanker_plate = null,
           accepted_at = null, arriving_at = null, arrived_at = null, filled_at = null, fill_site_id = null, fill_meter_gal = null, fill_verified = null
     where id = o.id;
    if p_kind = 'accident' or p_kind = 'breakdown' then
      update public.tankers set is_online = false where id = t.id;
    end if;
  end if;
  return i;
end $$;

create function public.dispute_penalty(p_penalty_id uuid, p_text text)
returns public.penalties
language plpgsql security definer set search_path = public
as $$
declare p public.penalties;
begin
  update public.penalties set state = 'disputed', dispute_text = btrim(p_text), disputed_at = now()
   where id = p_penalty_id and state = 'issued'
     and (driver_id = auth.uid() or (public.is_owner() and company_id = public.my_company_id()) or customer_id = auth.uid())
  returning * into p;
  if not found then raise exception 'cannot_dispute'; end if;
  if char_length(btrim(coalesce(p_text, ''))) < 3 then raise exception 'reason_required'; end if;
  return p;
end $$;

-- Driver or owner applies for a permit (renewal). Reviewed by NWS permit officers.
create function public.apply_permit(p_tanker_id uuid default null)
returns public.permits
language plpgsql security definer set search_path = public
as $$
declare tid uuid; t public.tankers; p public.permits;
begin
  if public.my_role() = 'driver' then tid := public.my_tanker_id();
  elsif public.is_owner() and public.in_my_company(p_tanker_id) then tid := p_tanker_id;
  else raise exception 'not_found'; end if;
  select * into t from public.tankers where id = tid;
  if not found then raise exception 'no_tanker'; end if;
  if exists (select 1 from public.permits where tanker_id = tid and status = 'pending') then raise exception 'application_pending'; end if;
  insert into public.permits (tanker_id, permit_no, type, issued_at, expires_at, applied_by, stage)
  values (tid, 'APP-' || regexp_replace(t.plate, '[^A-Z0-9]', '', 'g') || '-' || to_char(now(), 'YYMMDDHH24MISS'), t.service_type,
          now(), now() + interval '12 months', auth.uid(), 'submitted')
  returning * into p;
  return p;
end $$;

create function public.add_document(p_kind text, p_ref_no text, p_valid_to date, p_file_path text default null, p_tanker_id uuid default null, p_driver_id uuid default null)
returns public.tanker_documents
language plpgsql security definer set search_path = public
as $$
declare d public.tanker_documents; tid uuid; did uuid;
begin
  if public.my_role() = 'driver' then
    if p_kind = 'heavy_licence' then did := auth.uid(); else tid := public.my_tanker_id(); end if;
  elsif public.is_owner() then
    if p_driver_id is not null then
      if not exists (select 1 from public.profiles where id = p_driver_id and company_id = public.my_company_id()) then raise exception 'not_found'; end if;
      did := p_driver_id;
    elsif public.in_my_company(p_tanker_id) then tid := p_tanker_id;
    else raise exception 'not_found'; end if;
  else raise exception 'forbidden_for_role'; end if;
  if p_valid_to is null or p_valid_to < current_date then raise exception 'invalid_dates'; end if;
  insert into public.tanker_documents (tanker_id, driver_id, kind, ref_no, valid_to, file_path, status)
  values (tid, did, p_kind, coalesce(p_ref_no, ''), p_valid_to, p_file_path, 'pending_review') returning * into d;
  return d;
end $$;

-- ===========================================================================
-- Tanker company owners
-- ===========================================================================
create function public.owner_company()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select to_jsonb(c) || jsonb_build_object('earnings_balance', public.company_balance(c.id, 'earnings'),
                                           'fill_credit', public.company_balance(c.id, 'fill_credit'))
    from public.companies c where c.id = public.my_company_id() and public.is_owner()
$$;

create function public.owner_register_company(p_name text, p_cr_no text, p_phone text, p_bank_name text, p_iban text)
returns public.companies
language plpgsql security definer set search_path = public
as $$
declare c public.companies;
begin
  if public.my_role() is distinct from 'owner' then raise exception 'not_an_owner'; end if;
  if public.my_company_id() is not null then raise exception 'already_registered'; end if;
  begin
    insert into public.companies (name, cr_no, phone, bank_name, iban, status)
    values (btrim(p_name), upper(btrim(p_cr_no)), p_phone, p_bank_name, upper(replace(p_iban, ' ', '')), 'pending') returning * into c;
  exception when unique_violation then raise exception 'cr_taken';
  end;
  update public.profiles set company_id = c.id where id = auth.uid();
  return c;
end $$;

create function public.owner_register_tanker(p_plate text, p_service_type public.service_type, p_capacity_gal integer)
returns public.tankers
language plpgsql security definer set search_path = public
as $$
declare t public.tankers; dev text;
begin
  if not public.is_owner() then raise exception 'not_an_owner'; end if;
  begin
    insert into public.tankers (plate, service_type, capacity_gal, company_id)
    values (upper(btrim(p_plate)), p_service_type, p_capacity_gal, public.my_company_id()) returning * into t;
  exception when unique_violation then raise exception 'plate_taken';
  end;
  -- Simulated IVMS provisioning: every registered tanker gets a device.
  dev := 'IV-' || (70000 + (select count(*) from public.devices) + 1);
  insert into public.devices (id, tanker_id) values (dev, t.id) on conflict (id) do nothing;
  return t;
end $$;

-- Link a driver (who signed up in the Driver app) to this company by email.
create function public.owner_add_driver(p_email text)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare p public.profiles; uid uuid;
begin
  if not public.is_owner() then raise exception 'not_an_owner'; end if;
  select id into uid from auth.users where lower(email) = lower(btrim(p_email));
  select * into p from public.profiles where id = uid;
  if not found or p.role <> 'driver' then raise exception 'driver_not_found'; end if;
  if p.company_id is not null and p.company_id <> public.my_company_id() then raise exception 'driver_in_other_company'; end if;
  update public.profiles set company_id = public.my_company_id() where id = uid returning * into p;
  -- A tanker the driver registered themselves joins the company too.
  update public.tankers set company_id = public.my_company_id()
   where id = (select tanker_id from public.tanker_assignments where driver_id = uid and unassigned_at is null) and company_id is null;
  return p;
end $$;

create function public.owner_assign_driver(p_driver_id uuid, p_tanker_id uuid)
returns public.tanker_assignments
language plpgsql security definer set search_path = public
as $$
declare a public.tanker_assignments;
begin
  if not public.is_owner() or not public.in_my_company(p_tanker_id) then raise exception 'not_found'; end if;
  if not exists (select 1 from public.profiles where id = p_driver_id and role = 'driver' and company_id = public.my_company_id()) then raise exception 'not_found'; end if;
  if exists (select 1 from public.orders where (tanker_id = p_tanker_id or driver_id = p_driver_id) and status in ('accepted', 'arriving', 'arrived', 'collected')) then
    raise exception 'tanker_on_job';
  end if;
  update public.tanker_assignments set unassigned_at = now() where (tanker_id = p_tanker_id or driver_id = p_driver_id) and unassigned_at is null;
  update public.tankers set is_online = false where id in (p_tanker_id, (select tanker_id from public.tanker_assignments where driver_id = p_driver_id order by assigned_at desc limit 1));
  insert into public.tanker_assignments (driver_id, tanker_id, assigned_by) values (p_driver_id, p_tanker_id, auth.uid()) returning * into a;
  return a;
end $$;

create function public.owner_unassign(p_tanker_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_owner() or not public.in_my_company(p_tanker_id) then raise exception 'not_found'; end if;
  if exists (select 1 from public.orders where tanker_id = p_tanker_id and status in ('accepted', 'arriving', 'arrived', 'collected')) then raise exception 'tanker_on_job'; end if;
  update public.tanker_assignments set unassigned_at = now() where tanker_id = p_tanker_id and unassigned_at is null;
  update public.tankers set is_online = false where id = p_tanker_id;
end $$;

create function public.owner_decide_contract(p_contract_id uuid, p_accept boolean)
returns public.contracts
language plpgsql security definer set search_path = public
as $$
declare c public.contracts;
begin
  if not public.is_owner() then raise exception 'not_an_owner'; end if;
  update public.contracts set status = case when p_accept then 'active' else 'declined' end, decided_at = now()
   where id = p_contract_id and company_id = public.my_company_id() and status = 'pending_owner'
  returning * into c;
  if not found then raise exception 'not_found'; end if;
  perform public.notify(coalesce(c.customer_id, (select id from public.profiles where org_id = c.org_id and org_role = 'admin' limit 1)),
                        'contract_update', null, jsonb_build_object('contract', 'CT-' || c.contract_no, 'status', case when p_accept then 'accepted' else 'declined' end,
                                                    'status_ar', case when p_accept then 'قبول' else 'رفض' end));
  if p_accept then perform public.generate_contract_orders(); end if;
  return c;
end $$;

create function public.owner_topup_fill_credit(p_amount numeric)
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_owner() then raise exception 'not_an_owner'; end if;
  if p_amount is null or p_amount < 10 or p_amount > 10000 then raise exception 'invalid_amount'; end if;
  insert into public.company_tx (company_id, bucket, kind, amount, memo) values (public.my_company_id(), 'fill_credit', 'fill_topup', round(p_amount, 3), 'Filling credit top-up (bank transfer, simulated)');
  return public.owner_company();
end $$;

-- ===========================================================================
-- Business (B2B) accounts
-- ===========================================================================
create function public.org_outstanding(p_org uuid)
returns numeric language sql stable security definer set search_path = public
as $$
  select coalesce((select sum(total) from public.orders where org_id = p_org and billing = 'account' and invoice_id is null and status not in ('cancelled', 'pending_approval')), 0)
       + coalesce((select sum(total) from public.invoices where org_id = p_org and status <> 'paid'), 0)
$$;

create function public.org_summary()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select to_jsonb(o) || jsonb_build_object('credit_used', public.org_outstanding(o.id), 'my_role', public.my_org_role())
    from public.organizations o where o.id = public.my_org_id()
$$;

create function public.org_register(p_name text, p_cr_no text, p_segment text)
returns public.organizations
language plpgsql security definer set search_path = public
as $$
declare o public.organizations;
begin
  if public.my_role() is distinct from 'business' then raise exception 'forbidden_for_role'; end if;
  if public.my_org_id() is not null then raise exception 'already_registered'; end if;
  begin
    insert into public.organizations (name, cr_no, segment, status, credit_limit) values (btrim(p_name), upper(btrim(p_cr_no)), coalesce(p_segment, 'commercial'), 'pending', 0) returning * into o;
  exception when unique_violation then raise exception 'cr_taken';
  end;
  update public.profiles set org_id = o.id, org_role = 'admin' where id = auth.uid();
  return o;
end $$;

-- Bulk order: one order per tanker load, billed to the account.
create function public.org_create_orders(p_property_id uuid, p_service_type public.service_type, p_gallons integer, p_count integer,
                                         p_slot_start timestamptz default null, p_slot_end timestamptz default null, p_slot_label text default null,
                                         p_po_number text default null, p_note text default null)
returns setof public.orders
language plpgsql security definer set search_path = public
as $$
declare
  org public.organizations; prop public.properties; o public.orders; q record; st public.order_status; i integer; z public.zones;
begin
  if coalesce(public.my_org_role(), '') not in ('admin', 'site_manager') then raise exception 'forbidden_for_role'; end if;
  select * into org from public.organizations where id = public.my_org_id();
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

create function public.org_decide_order(p_order_id uuid, p_approve boolean, p_reason text default null)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders;
begin
  if coalesce(public.my_org_role(), '') <> 'admin' then raise exception 'forbidden_for_role'; end if;
  update public.orders
     set status = case when not p_approve then 'cancelled'::public.order_status
                       when slot_start is not null and slot_start > now() + interval '2 hours' then 'scheduled'::public.order_status
                       else 'requested'::public.order_status end,
         approved_by = auth.uid(), approved_at = now(),
         cancelled_at = case when p_approve then null else now() end,
         cancelled_by = case when p_approve then null else 'approver' end,
         cancel_reason = case when p_approve then null else coalesce(nullif(btrim(p_reason), ''), 'Not approved') end
   where id = p_order_id and org_id = public.my_org_id() and status = 'pending_approval'
  returning * into o;
  if not found then raise exception 'not_found'; end if;
  return o;
end $$;

create function public.org_add_member(p_email text, p_role text)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare p public.profiles; uid uuid;
begin
  if coalesce(public.my_org_role(), '') <> 'admin' then raise exception 'forbidden_for_role'; end if;
  if p_role not in ('admin', 'site_manager', 'finance') then raise exception 'invalid_role'; end if;
  select id into uid from auth.users where lower(email) = lower(btrim(p_email));
  select * into p from public.profiles where id = uid;
  if not found or p.role <> 'business' then raise exception 'user_not_found'; end if;
  if p.org_id is not null and p.org_id <> public.my_org_id() then raise exception 'user_in_other_org'; end if;
  if uid = auth.uid() then raise exception 'cannot_change_own_role'; end if;
  update public.profiles set org_id = public.my_org_id(), org_role = p_role where id = uid returning * into p;
  return p;
end $$;

-- Invoice the organisation's delivered, not yet invoiced account orders.
create function public.invoice_org(p_org uuid)
returns public.invoices
language plpgsql security definer set search_path = public
as $$
declare inv public.invoices; org public.organizations; n integer; sub numeric; v numeric; tot numeric; first_at timestamptz;
begin
  select * into org from public.organizations where id = p_org;
  select count(*), coalesce(sum(total - vat), 0), coalesce(sum(vat), 0), coalesce(sum(total), 0), min(delivered_at)
    into n, sub, v, tot, first_at
    from public.orders where org_id = p_org and billing = 'account' and status = 'delivered' and invoice_id is null;
  if n = 0 then raise exception 'nothing_to_invoice'; end if;
  insert into public.invoices (org_id, period_start, period_end, orders, subtotal, vat, total, due_at)
  values (p_org, first_at::date, current_date, n, sub, v, tot, now() + make_interval(days => org.terms_days)) returning * into inv;
  update public.orders set invoice_id = inv.id where org_id = p_org and billing = 'account' and status = 'delivered' and invoice_id is null;
  perform public.notify(m.id, 'invoice_issued', null, jsonb_build_object('invoice', 'INV-' || inv.invoice_no, 'amount', to_char(tot, 'FM99990.000')))
     from public.profiles m where m.org_id = p_org and m.org_role in ('admin', 'finance');
  return inv;
end $$;

create function public.org_generate_invoice()
returns public.invoices
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(public.my_org_role(), '') not in ('admin', 'finance') then raise exception 'forbidden_for_role'; end if;
  return public.invoice_org(public.my_org_id());
end $$;

create function public.org_pay_invoice(p_invoice_id uuid)
returns public.invoices
language plpgsql security definer set search_path = public
as $$
declare inv public.invoices;
begin
  if coalesce(public.my_org_role(), '') not in ('admin', 'finance') then raise exception 'forbidden_for_role'; end if;
  update public.invoices set status = 'paid', paid_at = now() where id = p_invoice_id and org_id = public.my_org_id() and status <> 'paid' returning * into inv;
  if not found then raise exception 'not_found'; end if;
  update public.payments set status = 'captured', captured_at = now() where order_id in (select id from public.orders where invoice_id = inv.id) and status = 'on_account';
  update public.orders set payment_status = 'captured' where invoice_id = inv.id;
  return inv;
end $$;

-- ===========================================================================
-- NWS staff (each checks the sub-role and writes one audit row)
-- ===========================================================================

-- Periodic control-room scan (any staff; also safe to run from cron): releases
-- scheduled orders, generates contract orders, raises alerts and fraud flags.
create function public.staff_scan()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare r record; released integer; generated integer; alerts_before bigint; flags_before bigint;
begin
  if not public.is_staff() and auth.uid() is not null then raise exception 'not_staff'; end if;
  select coalesce(max(id), 0) into alerts_before from public.alerts;
  select coalesce(max(id), 0) into flags_before from public.fraud_flags;
  generated := public.generate_contract_orders();
  released := public.release_due_orders();

  -- IVMS signal lost: online tankers silent for 5 minutes.
  for r in select * from public.tankers where is_online and (last_fix_at is null or last_fix_at < now() - interval '5 minutes') loop
    perform public.raise_alert(r.id, null, 'IVMS signal lost', 'med', format('%s online with no GPS for over 5 minutes', r.plate), r.last_lat, r.last_lng, 'signal:' || r.id);
  end loop;
  -- Non-renewed tanker on an active trip.
  for r in select o.id, o.order_no, t.id as tid, t.plate, t.last_lat, t.last_lng from public.orders o join public.tankers t on t.id = o.tanker_id
            where o.status in ('accepted', 'arriving', 'arrived', 'collected') and not public.tanker_has_valid_permit(t.id) loop
    perform public.raise_alert(r.tid, r.id, 'Non-renewed tanker on active trip', 'high', format('%s on TO-%s without a valid permit', r.plate, r.order_no), r.last_lat, r.last_lng, 'permit:' || r.id);
  end loop;
  -- Delivery window breach (and the late-delivery penalty after 30 minutes).
  for r in select o.*, t.last_lat as tl, t.last_lng as tg from public.orders o left join public.tankers t on t.id = o.tanker_id
            where o.slot_end is not null and o.slot_end < now() and o.status in ('requested', 'accepted', 'arriving') loop
    if not exists (select 1 from public.alerts where dedupe_key = 'window:' || r.id) and r.status in ('accepted', 'arriving') then
      perform public.notify(r.customer_id, 'driver_delayed', r.id, jsonb_build_object('order', 'TO-' || r.order_no));
    end if;
    perform public.raise_alert(r.tanker_id, r.id, 'Delivery window breach', 'med', format('TO-%s missed its %s window', r.order_no, coalesce(r.slot_label, 'delivery')), r.tl, r.tg, 'window:' || r.id);
    if r.tanker_id is not null and r.slot_end < now() - interval '30 minutes' then
      perform public.issue_penalty('late_delivery', r.id, r.tanker_id, format('More than 30 minutes past the %s window', coalesce(r.slot_label, 'delivery')), 'Slot end vs. arrival time');
    end if;
  end loop;
  -- Idle with load: filled, but no movement for 20 minutes.
  for r in select o.id, o.order_no, t.id as tid, t.plate, t.last_lat, t.last_lng from public.orders o join public.tankers t on t.id = o.tanker_id
            where o.status = 'arriving' and o.filled_at < now() - interval '20 minutes'
              and not exists (select 1 from public.gps_fixes g where g.tanker_id = t.id and g.recorded_at > now() - interval '20 minutes' and coalesce(g.speed_kmh, 0) > 5) loop
    perform public.raise_alert(r.tid, r.id, 'Idle with load', 'low', format('%s loaded for TO-%s and idle for 20 minutes', r.plate, r.order_no), r.last_lat, r.last_lng, 'idle:' || r.id);
  end loop;

  -- Fraud detection.
  insert into public.fraud_flags (rule, subject_type, subject_id, details, score, dedupe_key)
  select 'Delivery without filling', 'order', o.id::text, format('TO-%s delivered with no station fill event', o.order_no), 80, 'nofill:' || o.id
    from public.orders o where o.status = 'delivered' and o.service_type <> 'WW' and o.filled_at is null and o.delivered_at > now() - interval '30 days'
  on conflict (dedupe_key) do nothing;
  insert into public.fraud_flags (rule, subject_type, subject_id, details, score, dedupe_key)
  select 'Duplicate proof-of-delivery photo', 'order', p.order_id::text, format('Photo hash reused on %s deliveries', count(*) over (partition by p.photo_hash)), 90, 'pod:' || p.order_id
    from public.pods p where p.photo_hash is not null and p.photo_hash in (select photo_hash from public.pods where photo_hash is not null group by photo_hash having count(*) > 1)
  on conflict (dedupe_key) do nothing;
  insert into public.fraud_flags (rule, subject_type, subject_id, details, score, dedupe_key)
  select 'Rating manipulation', 'driver', x.driver_id::text, format('%s five-star ratings from one customer in 24 h', x.n), 60, 'rating:' || x.driver_id || ':' || x.customer_id || ':' || current_date
    from (select driver_id, customer_id, count(*) n from public.orders where rating = 5 and rated_at > now() - interval '24 hours' and driver_id is not null
           group by driver_id, customer_id having count(*) >= 3) x
  on conflict (dedupe_key) do nothing;
  insert into public.fraud_flags (rule, subject_type, subject_id, details, score, dedupe_key)
  select 'Wallet misuse', 'customer', w.customer_id::text, format('Top-ups of %s OMR in 24 h', to_char(sum(w.amount), 'FM99990.000')), 55, 'wallet:' || w.customer_id || ':' || current_date
    from public.wallet_tx w where w.kind = 'topup' and w.created_at > now() - interval '24 hours' group by w.customer_id having sum(w.amount) > 200
  on conflict (dedupe_key) do nothing;
  insert into public.fraud_flags (rule, subject_type, subject_id, details, score, dedupe_key)
  select 'Unusual ordering', 'customer', o.customer_id::text, format('%s orders in 24 h', count(*)), 40, 'orders:' || o.customer_id || ':' || current_date
    from public.orders o where o.created_at > now() - interval '24 hours' and o.org_id is null group by o.customer_id having count(*) > 5
  on conflict (dedupe_key) do nothing;

  return jsonb_build_object('released', released, 'contract_orders', generated,
                            'new_alerts', (select count(*) from public.alerts where id > alerts_before),
                            'new_flags', (select count(*) from public.fraud_flags where id > flags_before));
end $$;

create function public.staff_alert_action(p_alert_id bigint, p_action text, p_note text default null)
returns public.alerts
language plpgsql security definer set search_path = public
as $$
declare b public.alerts; a public.alerts; rule text;
begin
  perform public.require_staff(array['operator', 'admin', 'inspector']::public.staff_role[]);
  select * into b from public.alerts where id = p_alert_id for update;
  if not found then raise exception 'not_found'; end if;
  if p_action = 'acknowledge' then
    update public.alerts set state = 'acknowledged', acted_by = auth.uid(), acted_at = now(), action_note = p_note where id = b.id returning * into a;
  elsif p_action = 'resolve' then
    update public.alerts set state = 'resolved', acted_by = auth.uid(), acted_at = now(), action_note = p_note where id = b.id returning * into a;
  elsif p_action = 'suspend' then
    perform public.require_staff(array['operator']::public.staff_role[]);
    update public.tankers set blocked = true, blocked_reason = coalesce(nullif(btrim(p_note), ''), b.type), blocked_at = now(), blocked_by = auth.uid(), is_online = false
     where id = b.tanker_id and not blocked;
    update public.alerts set state = 'resolved', acted_by = auth.uid(), acted_at = now(), action_note = 'Tanker suspended: ' || coalesce(p_note, '') where id = b.id returning * into a;
  elsif p_action = 'penalty' then
    rule := case b.type when 'Discharge outside approved zone' then 'discharge_outside' when 'Non-renewed tanker on active trip' then 'expired_permit_trip'
                        when 'Delivery window breach' then 'late_delivery' when 'Short volume' then 'short_volume' end;
    if rule is null then raise exception 'no_penalty_rule_for_alert'; end if;
    if (public.issue_penalty(rule, b.order_id, b.tanker_id, coalesce(nullif(btrim(p_note), ''), b.type), 'Control room alert #' || b.id)).id is null then
      raise exception 'penalty_not_issued';
    end if;
    update public.alerts set state = 'resolved', acted_by = auth.uid(), acted_at = now(), action_note = 'Penalty issued (' || rule || ')' where id = b.id returning * into a;
  elsif p_action = 'inspector' then
    insert into public.inspections (tanker_id, permit_id, inspector_id, result, notes, scheduled_for)
    values (b.tanker_id, (select id from public.permits where tanker_id = b.tanker_id order by (status = 'pending') desc, expires_at desc limit 1),
            null, 'scheduled', 'From alert: ' || b.type, current_date);
    update public.alerts set state = 'acknowledged', acted_by = auth.uid(), acted_at = now(), action_note = 'Inspector dispatched' where id = b.id returning * into a;
  else raise exception 'invalid_action'; end if;
  perform public.write_audit('alert.' || p_action, 'alert', b.id::text, to_jsonb(b), to_jsonb(a), p_note);
  return a;
end $$;

create function public.staff_issue_penalty(p_rule text, p_tanker_id uuid, p_order_id uuid, p_reason text, p_amount numeric default null)
returns public.penalties
language plpgsql security definer set search_path = public
as $$
declare p public.penalties; r text;
begin
  perform public.require_staff(array['operator', 'inspector', 'admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  p := public.issue_penalty(p_rule, p_order_id, p_tanker_id, r, 'Issued by NWS staff', p_amount);
  if p.id is null then raise exception 'penalty_not_issued'; end if;
  perform public.write_audit('penalty.issue', 'penalty', p.id::text, null, to_jsonb(p), r);
  return p;
end $$;

create function public.staff_decide_penalty(p_penalty_id uuid, p_decision text, p_reason text)
returns public.penalties
language plpgsql security definer set search_path = public
as $$
declare b public.penalties; a public.penalties; r text;
begin
  perform public.require_staff(array['operator', 'admin', 'finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if p_decision not in ('uphold', 'cancel') then raise exception 'invalid_decision'; end if;
  select * into b from public.penalties where id = p_penalty_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.state not in ('issued', 'disputed') then raise exception 'invalid_state'; end if;
  update public.penalties set state = case when p_decision = 'uphold' then 'upheld' else 'cancelled' end, decided_by = auth.uid(), decided_at = now()
   where id = b.id returning * into a;
  if p_decision = 'cancel' and b.company_id is not null and b.amount > 0 then
    insert into public.company_tx (company_id, driver_id, tanker_id, kind, amount, order_id, penalty_id, memo)
    values (b.company_id, b.driver_id, b.tanker_id, 'penalty_reversal', b.amount, b.order_id, b.id, 'Penalty V-' || b.penalty_no || ' cancelled');
  elsif p_decision = 'cancel' and b.customer_id is not null and b.amount > 0 then
    insert into public.wallet_tx (customer_id, kind, amount, order_id, memo) values (b.customer_id, 'refund', b.amount, b.order_id, 'Penalty V-' || b.penalty_no || ' cancelled');
  end if;
  perform public.write_audit('penalty.' || p_decision, 'penalty', b.id::text, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

create function public.staff_order_action(p_order_id uuid, p_action text, p_reason text, p_tanker_id uuid default null, p_amount numeric default null,
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
    select * into t from public.tankers where id = p_tanker_id;
    if not found then raise exception 'not_found'; end if;
    if t.blocked or not public.tanker_has_valid_permit(t.id) then raise exception 'tanker_not_eligible'; end if;
    if t.service_type <> b.service_type or t.capacity_gal < b.gallons then raise exception 'tanker_not_eligible'; end if;
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

-- Call-centre order (Genesys): placed by an operator for an existing customer, paid on delivery.
create function public.staff_place_order(p_customer_id uuid, p_service_type public.service_type, p_gallons integer, p_lat double precision, p_lng double precision,
                                         p_area text, p_address text, p_genesys_id text, p_emergency boolean default false)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; z public.zones;
begin
  perform public.require_staff(array['operator', 'complaints_agent']::public.staff_role[]);
  if not exists (select 1 from public.profiles where id = p_customer_id and role = 'customer') then raise exception 'not_a_customer'; end if;
  if p_gallons is null or p_gallons < 1 or p_gallons > 20000 then raise exception 'invalid_gallons'; end if;
  if coalesce(btrim(p_area), '') = '' then raise exception 'area_required'; end if;
  z := public.zone_at(p_lat, p_lng);
  if z.id is null then raise exception 'outside_service_area'; end if;
  insert into public.orders (customer_id, service_type, gallons, area, zone_id, channel, genesys_id, is_emergency, pay_method)
  values (p_customer_id, p_service_type, p_gallons, left(btrim(p_area), 120), z.id, 'call_centre', nullif(btrim(coalesce(p_genesys_id, '')), ''), coalesce(p_emergency, false), 'cash')
  returning * into o;
  insert into public.order_locations (order_id, lat, lng, address) values (o.id, p_lat, p_lng, left(coalesce(btrim(p_address), ''), 300));
  insert into public.payments (order_id, customer_id, method, amount, status, gateway_ref) values (o.id, p_customer_id, 'cash', o.total, 'authorized', 'COD-' || o.order_no);
  update public.orders set payment_status = 'authorized' where id = o.id returning * into o;
  perform public.write_audit('order.create_for_caller', 'order', o.id::text, null, jsonb_build_object('order_no', o.order_no, 'genesys_id', p_genesys_id, 'customer_id', p_customer_id), 'Call-centre order');
  return o;
end $$;

create function public.staff_case_action(p_complaint_id uuid, p_action text, p_body text default null, p_team text default null, p_amount numeric default null)
returns public.complaints
language plpgsql security definer set search_path = public
as $$
declare b public.complaints; a public.complaints; refunded numeric;
begin
  perform public.require_staff(array['complaints_agent', 'operator', 'admin']::public.staff_role[]);
  select * into b from public.complaints where id = p_complaint_id for update;
  if not found then raise exception 'not_found'; end if;
  if p_action = 'assign' then
    update public.complaints set state = 'assigned', owner_team = coalesce(nullif(btrim(p_team), ''), owner_team) where id = b.id returning * into a;
  elsif p_action = 'escalate' then
    update public.complaints set state = 'escalated', owner_team = coalesce(nullif(btrim(p_team), ''), 'Tanker operations supervisor') where id = b.id returning * into a;
  elsif p_action = 'refund' then
    if coalesce(p_amount, 0) <= 0 or p_amount > 50 then raise exception 'invalid_amount'; end if;
    if b.order_id is not null then refunded := public.refund_to_wallet(b.order_id, p_amount, 'refund', 'Complaint C-' || b.case_no); end if;
    if coalesce(refunded, 0) = 0 and b.customer_id is not null then
      insert into public.wallet_tx (customer_id, kind, amount, order_id, memo) values (b.customer_id, 'goodwill', round(p_amount, 3), b.order_id, 'Complaint C-' || b.case_no);
      refunded := round(p_amount, 3);
    end if;
    update public.complaints set refund_amount = refund_amount + refunded where id = b.id returning * into a;
    insert into public.complaint_notes (complaint_id, author_id, author_role, body)
    values (b.id, auth.uid(), 'staff', 'Refunded ' || to_char(refunded, 'FM9990.000') || ' OMR to the customer''s wallet.');
  elsif p_action = 'resolve' then
    if char_length(btrim(coalesce(p_body, ''))) < 3 then raise exception 'reason_required'; end if;
    update public.complaints set state = 'resolved', resolved_at = now(), resolution = btrim(p_body) where id = b.id returning * into a;
    perform public.notify(b.customer_id, 'complaint_update', b.order_id, jsonb_build_object('case', 'C-' || b.case_no, 'status', 'resolved', 'status_ar', 'تم الحل'));
  elsif p_action = 'reopen' then
    update public.complaints set state = 'assigned', resolved_at = null where id = b.id and state = 'resolved' returning * into a;
    if not found then raise exception 'invalid_state'; end if;
  elsif p_action = 'note' then
    a := b;
  else raise exception 'invalid_action'; end if;
  if nullif(btrim(coalesce(p_body, '')), '') is not null then
    insert into public.complaint_notes (complaint_id, author_id, author_role, body, internal)
    values (b.id, auth.uid(), 'staff', btrim(p_body), p_action = 'note');
  end if;
  perform public.write_audit('complaint.' || p_action, 'complaint', b.id::text,
    jsonb_build_object('state', b.state, 'owner_team', b.owner_team, 'refund_amount', b.refund_amount),
    jsonb_build_object('state', a.state, 'owner_team', a.owner_team, 'refund_amount', a.refund_amount), p_body);
  return a;
end $$;

create function public.staff_log_call_complaint(p_customer_id uuid, p_order_id uuid, p_category text, p_description text, p_genesys_id text)
returns public.complaints
language plpgsql security definer set search_path = public
as $$
declare s public.complaint_sla; c public.complaints;
begin
  perform public.require_staff(array['complaints_agent', 'operator']::public.staff_role[]);
  select * into s from public.complaint_sla where category = p_category;
  if not found then raise exception 'invalid_category'; end if;
  insert into public.complaints (order_id, customer_id, category, description, channel, genesys_id, owner_team, sla_hours, due_at)
  values (p_order_id, p_customer_id, p_category, btrim(p_description), 'call_centre', nullif(btrim(coalesce(p_genesys_id, '')), ''), s.team, s.hours, now() + make_interval(hours => s.hours))
  returning * into c;
  insert into public.complaint_notes (complaint_id, author_id, author_role, body) values (c.id, auth.uid(), 'staff', 'Logged from call ' || coalesce(p_genesys_id, '') || ': ' || btrim(p_description));
  perform public.write_audit('complaint.create_from_call', 'complaint', c.id::text, null, to_jsonb(c), p_genesys_id);
  return c;
end $$;

create function public.staff_run_payout_batch()
returns public.payout_batches
language plpgsql security definer set search_path = public
as $$
declare b public.payout_batches; r record; tot numeric := 0; n integer := 0;
begin
  perform public.require_staff(array['finance', 'admin']::public.staff_role[]);
  perform pg_advisory_xact_lock(hashtext('nama.payout_batch'));
  insert into public.payout_batches (run_by, total, companies) values (auth.uid(), 0, 0) returning * into b;
  for r in select company_id, sum(amount) bal from public.company_tx where bucket = 'earnings' group by company_id having sum(amount) > 0 loop
    insert into public.company_tx (company_id, kind, amount, payout_batch_id, memo) values (r.company_id, 'payout', -r.bal, b.id, 'Payout batch PB-' || b.batch_no);
    perform public.notify(m.id, 'payout_sent', null, jsonb_build_object('amount', to_char(r.bal, 'FM99990.000'), 'batch', 'PB-' || b.batch_no))
       from public.profiles m where m.company_id = r.company_id and m.role = 'owner';
    tot := tot + r.bal; n := n + 1;
  end loop;
  if n = 0 then raise exception 'nothing_to_pay'; end if;
  update public.payout_batches set total = tot, companies = n where id = b.id returning * into b;
  perform public.write_audit('payout.batch', 'payout_batch', b.id::text, null, to_jsonb(b), null);
  return b;
end $$;

create function public.staff_customer_action(p_customer_id uuid, p_action text, p_reason text, p_amount numeric default null)
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
  elsif p_action = 'verify_id' then
    perform public.require_staff(array['operator', 'admin', 'complaints_agent']::public.staff_role[]);
    update public.profiles set id_verified = true where id = b.id returning * into a;
  else raise exception 'invalid_action'; end if;
  perform public.write_audit('customer.' || p_action, 'profile', b.id::text,
    jsonb_build_object('account_blocked', b.account_blocked, 'id_verified', b.id_verified),
    jsonb_build_object('account_blocked', a.account_blocked, 'id_verified', a.id_verified, 'amount', p_amount), r);
  return a;
end $$;

create function public.staff_update_pricing_rule(p_rule_key text, p_value text, p_status public.rule_status, p_source text, p_reason text)
returns public.pricing_rules
language plpgsql security definer set search_path = public
as $$
declare b public.pricing_rules; a public.pricing_rules; r text;
begin
  perform public.require_staff(array['admin', 'finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.pricing_rules where rule_key = p_rule_key for update;
  if not found then raise exception 'not_found'; end if;
  if p_rule_key = 'dw_above_650_basis' then
    if p_value not in ('slab', 'whole_volume') then raise exception 'invalid_value'; end if;
  elsif p_value !~ '^[0-9]+(\.[0-9]+)?$' then raise exception 'invalid_value';
  end if;
  update public.pricing_rules set value = btrim(p_value), status = p_status, source = coalesce(nullif(btrim(p_source), ''), source), updated_at = now()
   where rule_key = p_rule_key returning * into a;
  perform public.write_audit('pricing.update', 'pricing_rule', p_rule_key, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

create function public.staff_set_emergency(p_on boolean, p_zone text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare b jsonb := public.setting_json('EMERGENCY'); a jsonb; r text;
begin
  perform public.require_staff(array['operator', 'admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if p_on and not exists (select 1 from public.zones where name = p_zone) then raise exception 'invalid_value'; end if;
  a := jsonb_build_object('on', p_on, 'zone', case when p_on then p_zone end, 'reason', case when p_on then r end, 'since', case when p_on then now() end);
  update public.app_settings set value = a::text where key = 'EMERGENCY';
  perform public.write_audit('emergency.' || case when p_on then 'activate' else 'deactivate' end, 'setting', 'EMERGENCY', b, a, r);
  return a;
end $$;

create function public.staff_update_setting(p_key text, p_value jsonb, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare b jsonb; r text;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if p_key not in ('PRIVACY', 'LOYALTY') then raise exception 'invalid_setting'; end if;
  if p_key = 'LOYALTY' and not (coalesce((p_value ->> 'points_per_omr')::numeric, 0) > 0 and coalesce((p_value ->> 'redeem_points')::numeric, 0) >= 1
                                and coalesce((p_value ->> 'redeem_omr')::numeric, 0) > 0) then
    raise exception 'invalid_value';
  end if;
  if p_key = 'PRIVACY' and not (p_value ?& array['mask_phone', 'mask_address', 'retention_gps_days', 'retention_orders_years', 'usage_data_default']) then
    raise exception 'invalid_value';
  end if;
  b := public.setting_json(p_key);
  update public.app_settings set value = p_value::text where key = p_key;
  perform public.write_audit('setting.update', 'setting', p_key, b, p_value, r);
  return p_value;
end $$;

create function public.staff_set_active(p_kind text, p_id uuid, p_active boolean, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare r text; b boolean;
begin
  perform public.require_staff(array['admin', 'operator']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if p_kind = 'zone' then
    select active into b from public.zones where id = p_id; if not found then raise exception 'not_found'; end if;
    update public.zones set active = p_active where id = p_id;
  elsif p_kind = 'site' then
    select active into b from public.sites where id = p_id; if not found then raise exception 'not_found'; end if;
    update public.sites set active = p_active where id = p_id;
  else raise exception 'invalid_kind'; end if;
  perform public.write_audit(p_kind || '.' || case when p_active then 'enable' else 'disable' end, p_kind, p_id::text,
    jsonb_build_object('active', b), jsonb_build_object('active', p_active), r);
end $$;

create function public.staff_update_penalty_rule(p_code text, p_amount numeric, p_active boolean, p_reason text)
returns public.penalty_rules
language plpgsql security definer set search_path = public
as $$
declare b public.penalty_rules; a public.penalty_rules; r text;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.penalty_rules where code = p_code for update;
  if not found then raise exception 'not_found'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'invalid_amount'; end if;
  update public.penalty_rules set amount = p_amount, active = coalesce(p_active, active) where code = p_code returning * into a;
  perform public.write_audit('penalty_rule.update', 'penalty_rule', p_code, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

create function public.staff_upsert_promotion(p_code text, p_label text, p_pct numeric, p_audience text, p_max_uses integer, p_active boolean, p_valid_to date, p_reason text)
returns public.promotions
language plpgsql security definer set search_path = public
as $$
declare b public.promotions; a public.promotions; r text; c text := upper(btrim(p_code));
begin
  perform public.require_staff(array['admin', 'finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.promotions where code = c;
  insert into public.promotions (code, label, pct, audience, max_uses, active, valid_to) values (c, p_label, p_pct, p_audience, p_max_uses, p_active, p_valid_to)
  on conflict (code) do update set label = excluded.label, pct = excluded.pct, audience = excluded.audience, max_uses = excluded.max_uses,
                                   active = excluded.active, valid_to = excluded.valid_to
  returning * into a;
  perform public.write_audit('promotion.upsert', 'promotion', c, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

create function public.staff_update_template(p_event text, p_push boolean, p_sms boolean, p_whatsapp boolean, p_title_en text, p_body_en text, p_title_ar text, p_body_ar text, p_reason text)
returns public.notification_templates
language plpgsql security definer set search_path = public
as $$
declare b public.notification_templates; a public.notification_templates; r text;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.notification_templates where event = p_event for update;
  if not found then raise exception 'not_found'; end if;
  update public.notification_templates
     set push = p_push, sms = p_sms, whatsapp = p_whatsapp,
         title_en = coalesce(nullif(btrim(p_title_en), ''), title_en), body_en = coalesce(nullif(btrim(p_body_en), ''), body_en),
         title_ar = coalesce(nullif(btrim(p_title_ar), ''), title_ar), body_ar = coalesce(nullif(btrim(p_body_ar), ''), body_ar)
   where event = p_event returning * into a;
  perform public.write_audit('template.update', 'notification_template', p_event, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

-- Staff roles: tanker-company owners and business users can't be made staff
-- (their accounts would silently change type); otherwise as in 0008.
create or replace function public.staff_set_role(p_user_id uuid, p_staff_role public.staff_role, p_reason text)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare b public.profiles; a public.profiles; r text;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if p_user_id = auth.uid() then raise exception 'cannot_change_own_role'; end if;
  select * into b from public.profiles where id = p_user_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.role = 'driver' then raise exception 'target_is_driver'; end if;
  if b.role in ('owner', 'business') then raise exception 'target_not_eligible'; end if;
  update public.profiles
     set role = case when p_staff_role is null then 'customer'::public.user_role else 'nws_staff'::public.user_role end,
         staff_role = p_staff_role
   where id = p_user_id returning * into a;
  perform public.write_audit('staff.set_role', 'profile', a.id::text,
    jsonb_build_object('role', b.role, 'staff_role', b.staff_role), jsonb_build_object('role', a.role, 'staff_role', a.staff_role), r);
  return a;
end $$;

-- Admin: make an existing account staff by email (or change / remove the role), with zones.
create function public.staff_set_role_by_email(p_email text, p_staff_role public.staff_role, p_zones text[], p_reason text)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare uid uuid; p public.profiles;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  select id into uid from auth.users where lower(email) = lower(btrim(p_email));
  if uid is null then raise exception 'user_not_found'; end if;
  p := public.staff_set_role(uid, p_staff_role, p_reason);
  update public.profiles set staff_zones = coalesce(p_zones, '{}') where id = uid returning * into p;
  return p;
end $$;

create function public.staff_permit_stage(p_permit_id uuid, p_stage text, p_note text default null)
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
  elsif p_stage in ('documents', 'inspection', 'decision') then
    update public.permits set stage = p_stage, info_requested = null, updated_at = now() where id = b.id returning * into a;
  else raise exception 'invalid_stage'; end if;
  perform public.write_audit('permit.stage', 'permit', b.id::text, jsonb_build_object('stage', b.stage, 'info_requested', b.info_requested),
                             jsonb_build_object('stage', a.stage, 'info_requested', a.info_requested), p_note);
  return a;
end $$;

-- Automatic checks shown on a permit application (ROP and others are simulated stubs).
create function public.permit_auto_checks(p_permit_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare p public.permits; t public.tankers; viol integer; wt public.water_tests;
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  select * into p from public.permits where id = p_permit_id;
  if not found then raise exception 'not_found'; end if;
  select * into t from public.tankers where id = p.tanker_id;
  select count(*) into viol from public.penalties where tanker_id = t.id and state in ('issued', 'upheld') and created_at > now() - interval '12 months';
  select * into wt from public.water_tests where tanker_id = t.id order by tested_at desc limit 1;
  return jsonb_build_array(
    jsonb_build_object('check', 'ROP vehicle record', 'ok', t.plate !~ '13$', 'detail', case when t.plate ~ '13$' then 'Owner name mismatch on ROP record' else 'Plate, chassis and owner match' end),
    jsonb_build_object('check', 'IVMS device', 'ok', exists (select 1 from public.devices where tanker_id = t.id), 'detail', coalesce((select id || ' reporting' from public.devices where tanker_id = t.id), 'No device installed')),
    jsonb_build_object('check', 'Water quality test', 'ok', t.service_type <> 'DW' or coalesce(wt.passed and wt.tested_at > current_date - 180, false),
                       'detail', case when t.service_type <> 'DW' then 'Not required for ' || t.service_type when wt.id is null then 'No test on file' else wt.cert_no || ' · ' || case when wt.passed then 'passed' else 'failed' end || ' ' || wt.tested_at end),
    jsonb_build_object('check', 'Violations in the last 12 months', 'ok', viol < 3, 'detail', viol || ' upheld or open'),
    jsonb_build_object('check', 'Insurance', 'ok', exists (select 1 from public.tanker_documents where tanker_id = t.id and kind = 'insurance' and valid_to >= current_date and status = 'valid'),
                       'detail', coalesce((select 'Valid to ' || max(valid_to) from public.tanker_documents where tanker_id = t.id and kind = 'insurance' and status = 'valid'), 'No policy on file')));
end $$;

create function public.staff_record_inspection(p_tanker_id uuid, p_permit_id uuid, p_result text, p_notes text, p_checklist jsonb default '{}'::jsonb)
returns public.inspections
language plpgsql security definer set search_path = public
as $$
declare i public.inspections;
begin
  perform public.require_staff(array['inspector', 'permit_officer']::public.staff_role[]);
  if p_result not in ('pass', 'fail', 'scheduled') then raise exception 'invalid_result'; end if;
  if not exists (select 1 from public.tankers where id = p_tanker_id) then raise exception 'not_found'; end if;
  update public.inspections
     set result = p_result, inspector_id = auth.uid(), notes = btrim(notes || E'\n' || coalesce(p_notes, '')), checklist = coalesce(p_checklist, '{}'::jsonb),
         permit_id = coalesce(p_permit_id, permit_id)
   where id = (select id from public.inspections where tanker_id = p_tanker_id and result = 'scheduled' and p_result <> 'scheduled' order by created_at limit 1)
  returning * into i;
  if i.id is null then
    insert into public.inspections (tanker_id, permit_id, inspector_id, result, notes, checklist, scheduled_for)
    values (p_tanker_id, p_permit_id, auth.uid(), p_result, coalesce(p_notes, ''), coalesce(p_checklist, '{}'::jsonb),
            case when p_result = 'scheduled' then current_date + 1 else current_date end) returning * into i;
  end if;
  if p_permit_id is not null and p_result = 'pass' then
    update public.permits set stage = 'decision', updated_at = now() where id = p_permit_id and status = 'pending';
  end if;
  perform public.write_audit('inspection.' || p_result, 'tanker', p_tanker_id::text, null, to_jsonb(i), p_notes);
  return i;
end $$;

create function public.staff_review_document(p_document_id uuid, p_approve boolean, p_reason text default null)
returns public.tanker_documents
language plpgsql security definer set search_path = public
as $$
declare b public.tanker_documents; a public.tanker_documents;
begin
  perform public.require_staff(array['permit_officer', 'inspector']::public.staff_role[]);
  select * into b from public.tanker_documents where id = p_document_id for update;
  if not found then raise exception 'not_found'; end if;
  update public.tanker_documents set status = case when p_approve then 'valid' else 'rejected' end where id = b.id returning * into a;
  perform public.write_audit('document.' || case when p_approve then 'approve' else 'reject' end, 'document', b.id::text, to_jsonb(b), to_jsonb(a),
                             case when p_approve then p_reason else public.require_reason(p_reason) end);
  return a;
end $$;

create function public.staff_incident_action(p_incident_id uuid, p_action text, p_note text default null)
returns public.incidents
language plpgsql security definer set search_path = public
as $$
declare b public.incidents; a public.incidents;
begin
  perform public.require_staff(array['admin', 'operator']::public.staff_role[]);
  select * into b from public.incidents where id = p_incident_id for update;
  if not found then raise exception 'not_found'; end if;
  if p_action = 'acknowledge' and b.state = 'open' then
    update public.incidents set state = 'acknowledged', acknowledged_at = now(), notes = btrim(notes || E'\n' || coalesce(p_note, '')) where id = b.id returning * into a;
  elsif p_action = 'resolve' and b.state <> 'resolved' then
    update public.incidents set state = 'resolved', resolved_at = now(), acknowledged_at = coalesce(acknowledged_at, now()), notes = btrim(notes || E'\n' || coalesce(p_note, '')) where id = b.id returning * into a;
  else raise exception 'invalid_transition'; end if;
  perform public.write_audit('incident.' || p_action, 'incident', b.id::text, to_jsonb(b), to_jsonb(a), p_note);
  return a;
end $$;

create function public.staff_open_incident(p_priority text, p_title text, p_system text)
returns public.incidents
language plpgsql security definer set search_path = public
as $$
declare i public.incidents;
begin
  perform public.require_staff(array['admin', 'operator']::public.staff_role[]);
  if char_length(btrim(coalesce(p_title, ''))) < 3 or char_length(btrim(coalesce(p_system, ''))) < 2 then raise exception 'invalid_value'; end if;
  if not exists (select 1 from public.incident_targets where priority = p_priority) then raise exception 'invalid_value'; end if;
  insert into public.incidents (priority, title, system) values (p_priority, btrim(p_title), btrim(p_system)) returning * into i;
  perform public.write_audit('incident.open', 'incident', i.id::text, null, to_jsonb(i), null);
  return i;
end $$;

-- Simulated interface test: records the time and a latency.
create function public.staff_test_integration(p_key text)
returns public.integrations
language plpgsql security definer set search_path = public
as $$
declare i public.integrations;
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  update public.integrations set last_test_at = now(), latency_ms = 80 + floor(random() * 700)::integer where key = p_key returning * into i;
  if not found then raise exception 'not_found'; end if;
  return i;
end $$;

create function public.staff_fraud_decide(p_flag_id bigint, p_state text, p_reason text)
returns public.fraud_flags
language plpgsql security definer set search_path = public
as $$
declare b public.fraud_flags; a public.fraud_flags; r text;
begin
  perform public.require_staff(array['admin', 'operator', 'finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if p_state not in ('cleared', 'confirmed') then raise exception 'invalid_state'; end if;
  select * into b from public.fraud_flags where id = p_flag_id for update;
  if not found then raise exception 'not_found'; end if;
  update public.fraud_flags set state = p_state, decided_by = auth.uid() where id = b.id returning * into a;
  perform public.write_audit('fraud.' || p_state, 'fraud_flag', b.id::text, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

create function public.staff_close_data_request(p_request_id uuid, p_state text, p_reason text)
returns public.data_requests
language plpgsql security definer set search_path = public
as $$
declare b public.data_requests; a public.data_requests; r text;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if p_state not in ('completed', 'rejected') then raise exception 'invalid_state'; end if;
  select * into b from public.data_requests where id = p_request_id for update;
  if not found then raise exception 'not_found'; end if;
  update public.data_requests set state = p_state, closed_at = now(), closed_by = auth.uid() where id = b.id returning * into a;
  perform public.write_audit('data_request.' || p_state, 'data_request', b.id::text, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

create function public.staff_org_action(p_org_id uuid, p_action text, p_reason text, p_amount numeric default null)
returns public.organizations
language plpgsql security definer set search_path = public
as $$
declare b public.organizations; a public.organizations; r text;
begin
  perform public.require_staff(array['finance', 'admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into b from public.organizations where id = p_org_id for update;
  if not found then raise exception 'not_found'; end if;
  if p_action = 'raise_limit' then
    if coalesce(p_amount, 0) <= 0 then raise exception 'invalid_amount'; end if;
    update public.organizations set credit_limit = credit_limit + p_amount where id = b.id returning * into a;
  elsif p_action = 'pause' then update public.organizations set paused = true where id = b.id returning * into a;
  elsif p_action = 'resume' then update public.organizations set paused = false where id = b.id returning * into a;
  elsif p_action = 'activate' then update public.organizations set status = 'active' where id = b.id returning * into a;
  elsif p_action = 'invoice' then perform public.invoice_org(b.id); a := b;
  else raise exception 'invalid_action'; end if;
  perform public.write_audit('org.' || p_action, 'organization', b.id::text, to_jsonb(b), to_jsonb(a), r);
  return a;
end $$;

create function public.staff_company_action(p_company_id uuid, p_action text, p_reason text)
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
  perform public.write_audit('company.' || p_action, 'company', p_company_id::text, jsonb_build_object('status', b),
                             jsonb_build_object('status', case when p_action = 'activate' then 'active' else 'suspended' end), r);
end $$;

create function public.staff_save_scheduled_report(p_name text, p_dataset text, p_group_by text, p_cadence text, p_format text, p_recipients text)
returns public.scheduled_reports
language plpgsql security definer set search_path = public
as $$
declare s public.scheduled_reports;
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  if char_length(btrim(coalesce(p_name, ''))) < 3
     or p_dataset not in ('orders', 'revenue', 'complaints', 'ratings', 'fleet', 'payments')
     or p_group_by not in ('day', 'service', 'zone', 'company', 'category', 'channel') then
    raise exception 'invalid_value';
  end if;
  insert into public.scheduled_reports (name, dataset, group_by, cadence, format, recipients, created_by)
  values (btrim(p_name), p_dataset, p_group_by, p_cadence, p_format, coalesce(p_recipients, ''), auth.uid()) returning * into s;
  perform public.write_audit('report.schedule', 'scheduled_report', s.id::text, null, to_jsonb(s), null);
  return s;
end $$;

-- Staff can also message an order (masked call/chat relay).
-- (send_message above already allows staff.)

-- ===========================================================================
-- Sign-up: owners and business users may self-register; staff still never.
-- ===========================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name, phone)
  values (
    new.id,
    case new.raw_user_meta_data ->> 'role'
      when 'driver' then 'driver'::public.user_role
      when 'owner' then 'owner'::public.user_role
      when 'business' then 'business'::public.user_role
      else 'customer'::public.user_role end,
    coalesce(left(new.raw_user_meta_data ->> 'full_name', 120), ''),
    left(new.raw_user_meta_data ->> 'phone', 32)
  );
  return new;
end $$;

-- ===========================================================================
-- Execute rights
-- ===========================================================================
revoke execute on function
  public.refund_to_wallet(uuid, numeric, text, text), public.settle_order(uuid),
  public.issue_penalty(text, uuid, uuid, text, text, numeric),
  public.raise_alert(uuid, uuid, text, text, text, double precision, double precision, text),
  public.release_due_orders(), public.generate_contract_orders(), public.invoice_org(uuid), public.org_outstanding(uuid)
from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'my_wallet()', 'quote_order(public.service_type, integer, timestamptz, boolean, text)',
    'create_order(public.service_type, integer, double precision, double precision, text, text, uuid, timestamptz, timestamptz, text, boolean, text, text, text, text)',
    'cancel_order_with_fee(uuid, text)', 'reschedule_order(uuid, timestamptz, timestamptz, text)', 'rate_order(uuid, integer, text, numeric, text)',
    'wallet_topup(numeric, text, text)', 'redeem_points()', 'add_payment_method(text, text)', 'remove_payment_method(uuid)',
    'save_property(uuid, text, text, text, double precision, double precision, integer)', 'delete_property(uuid)', 'verify_identity(text, text)',
    'file_complaint(uuid, text, text, text)', 'complaint_reply(uuid, text)', 'send_message(uuid, text)', 'mark_notifications_read(bigint[])',
    'order_verification(uuid)', 'file_data_request(text, text)',
    'create_contract(uuid, uuid, public.service_type, integer, text, text, text, date, integer)', 'contract_set_status(uuid, text)',
    'submit_shift_check(jsonb)', 'set_availability(integer, boolean, text, uuid)', 'open_requests_near(double precision, double precision)',
    'driver_scheduled_jobs()', 'confirm_fill(uuid)',
    'submit_pod(uuid, integer, text, text, text, boolean, boolean, double precision, double precision)', 'confirm_discharge(uuid)',
    'report_trip_issue(uuid, text, text)', 'dispute_penalty(uuid, text)', 'apply_permit(uuid)', 'add_document(text, text, date, text, uuid, uuid)',
    'owner_company()', 'owner_register_company(text, text, text, text, text)', 'owner_register_tanker(text, public.service_type, integer)',
    'owner_add_driver(text)', 'owner_assign_driver(uuid, uuid)', 'owner_unassign(uuid)', 'owner_decide_contract(uuid, boolean)', 'owner_topup_fill_credit(numeric)',
    'org_summary()', 'org_register(text, text, text)',
    'org_create_orders(uuid, public.service_type, integer, integer, timestamptz, timestamptz, text, text, text)',
    'org_decide_order(uuid, boolean, text)', 'org_add_member(text, text)', 'org_generate_invoice()', 'org_pay_invoice(uuid)',
    'staff_scan()', 'staff_alert_action(bigint, text, text)', 'staff_issue_penalty(text, uuid, uuid, text, numeric)', 'staff_decide_penalty(uuid, text, text)',
    'staff_order_action(uuid, text, text, uuid, numeric, timestamptz, timestamptz, text)',
    'staff_place_order(uuid, public.service_type, integer, double precision, double precision, text, text, text, boolean)',
    'staff_case_action(uuid, text, text, text, numeric)', 'staff_log_call_complaint(uuid, uuid, text, text, text)', 'staff_run_payout_batch()',
    'staff_customer_action(uuid, text, text, numeric)', 'staff_update_pricing_rule(text, text, public.rule_status, text, text)',
    'staff_set_emergency(boolean, text, text)', 'staff_update_setting(text, jsonb, text)', 'staff_set_active(text, uuid, boolean, text)',
    'staff_update_penalty_rule(text, numeric, boolean, text)', 'staff_upsert_promotion(text, text, numeric, text, integer, boolean, date, text)',
    'staff_update_template(text, boolean, boolean, boolean, text, text, text, text, text)', 'staff_set_role_by_email(text, public.staff_role, text[], text)',
    'staff_permit_stage(uuid, text, text)', 'permit_auto_checks(uuid)', 'staff_record_inspection(uuid, uuid, text, text, jsonb)',
    'staff_review_document(uuid, boolean, text)', 'staff_incident_action(uuid, text, text)', 'staff_open_incident(text, text, text)',
    'staff_test_integration(text)', 'staff_fraud_decide(bigint, text, text)', 'staff_close_data_request(uuid, text, text)',
    'staff_org_action(uuid, text, text, numeric)', 'staff_company_action(uuid, text, text)',
    'staff_save_scheduled_report(text, text, text, text, text, text)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
