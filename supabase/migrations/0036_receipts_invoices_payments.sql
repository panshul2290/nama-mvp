-- Money and price integrity, part 3 of 3: what the customer and the business get on paper,
-- and payments that confirm at once.
--
--   #5 receipts        every delivered household order gets an e-receipt with a number from a
--                      per-year sequence (RCT-2026-000001…), issued by a trigger on delivery
--                      with a snapshot of the seller (SELLER setting) and the price lines, and a
--                      "Your receipt is ready" notification (template receipt_ready, EN/AR).
--                      order_receipt() returns everything the bilingual receipt page shows
--                      (/customer/receipt?order=…). Earlier deliveries are backfilled, numbered
--                      in delivery order, without notifications.
--   #6 Fawtara-ready   business invoices carry what a PEPPOL / UBL 2.1 e-invoice needs: invoice
--                      type code (380), currency OMR, issue date and time (issued_at), seller and
--                      buyer VAT numbers (VATIN) and names, and invoice_lines (one per order:
--                      quantity in gallons, net amount, VAT category S, rate and amount, line
--                      total). organizations.vat_number (OM + 10 digits) is set by the business
--                      admin or finance (org_set_vat_number) or by NWS (staff_set_org_vat_number);
--                      the platform's own is SELLER.vat_number (staff_update_seller). The UBL XML
--                      itself is built by lib/ubl.ts in the browser.
--   #7 payments        top-ups are records (topups, TU-<n>) with a status, and the simulated
--                      gateway confirms at once; card ending 0003 simulates a gateway that
--                      answers later (pending, confirmed by confirm_simulated_payments within
--                      a minute, pg_cron). An order paid by a pending card stays dispatched
--                      (nothing waits for payment_status). payments, topups and wallet_tx are in
--                      the realtime publication, so the customer screens update live.
--
-- VAT treatment is still pending with NWS / the Tax Authority (rule vat_rate, Q07): receipts
-- and invoices say so.

-- ===========================================================================
-- Seller details (the platform operator) and VAT numbers
-- ===========================================================================
insert into public.app_settings (key, value, notes) values
  ('SELLER', '{"name_en": "Nama Water Services", "name_ar": "نماء لخدمات المياه", "operator_en": "Tanker platform operator", "operator_ar": "مشغّل منصة الصهاريج", "address_en": "Muscat, Sultanate of Oman", "address_ar": "مسقط، سلطنة عُمان", "cr_no": "", "vat_number": ""}',
   'Seller on receipts and invoices. vat_number: the platform''s VAT registration number (OM + 10 digits), empty until confirmed.')
on conflict (key) do nothing;

alter table public.organizations
  add column vat_number text check (vat_number is null or vat_number ~ '^OM[0-9]{10}$');

create function public.normalize_vatin(p text)
returns text language sql immutable
as $$ select nullif(upper(regexp_replace(coalesce(p, ''), '[\s-]', '', 'g')), '') $$;

create function public.staff_update_seller(p_value jsonb, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare b jsonb; r text; v jsonb; k text;
begin
  perform public.require_staff(array['finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if jsonb_typeof(p_value) <> 'object' then raise exception 'invalid_value'; end if;
  b := public.setting_json('SELLER');
  v := coalesce(b, '{}'::jsonb);
  foreach k in array array['name_en', 'name_ar', 'operator_en', 'operator_ar', 'address_en', 'address_ar', 'cr_no'] loop
    if p_value ? k then
      if jsonb_typeof(p_value -> k) <> 'string' or char_length(p_value ->> k) > 200 then raise exception 'invalid_value: %', k; end if;
      v := v || jsonb_build_object(k, btrim(p_value ->> k));
    end if;
  end loop;
  if p_value ? 'vat_number' then
    if coalesce(public.normalize_vatin(p_value ->> 'vat_number'), '') !~ '^(OM[0-9]{10})?$' then
      raise exception 'invalid_vat_number: a VAT number is OM followed by 10 digits';
    end if;
    v := v || jsonb_build_object('vat_number', coalesce(public.normalize_vatin(p_value ->> 'vat_number'), ''));
  end if;
  if coalesce(btrim(v ->> 'name_en'), '') = '' or coalesce(btrim(v ->> 'name_ar'), '') = '' then raise exception 'invalid_value: the seller needs a name in both languages'; end if;
  update public.app_settings set value = v::text where key = 'SELLER';
  perform public.write_audit('setting.update', 'setting', 'SELLER', b, v, r);
  return v;
end $$;

create function public.org_set_vat_number(p_vat_number text)
returns public.organizations
language plpgsql security definer set search_path = public
as $$
declare o public.organizations; v text := public.normalize_vatin(p_vat_number);
begin
  if coalesce(public.my_org_role(), '') not in ('admin', 'finance') or public.my_sites_restricted() then raise exception 'forbidden_for_role'; end if;
  if v is not null and v !~ '^OM[0-9]{10}$' then raise exception 'invalid_vat_number: a VAT number is OM followed by 10 digits'; end if;
  update public.organizations set vat_number = v where id = public.my_org_id() returning * into o;
  if not found then raise exception 'not_found'; end if;
  return o;
end $$;

create function public.staff_set_org_vat_number(p_org_id uuid, p_vat_number text, p_reason text)
returns public.organizations
language plpgsql security definer set search_path = public
as $$
declare b public.organizations; a public.organizations; r text; v text := public.normalize_vatin(p_vat_number);
begin
  perform public.require_staff(array['finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if v is not null and v !~ '^OM[0-9]{10}$' then raise exception 'invalid_vat_number: a VAT number is OM followed by 10 digits'; end if;
  select * into b from public.organizations where id = p_org_id for update;
  if not found then raise exception 'not_found'; end if;
  update public.organizations set vat_number = v where id = p_org_id returning * into a;
  perform public.write_audit('org.vat_number', 'organization', p_org_id::text, jsonb_build_object('vat_number', b.vat_number), jsonb_build_object('vat_number', a.vat_number), r);
  return a;
end $$;

-- ===========================================================================
-- #5 household e-receipts
-- ===========================================================================
create table public.receipt_counters (
  year    integer primary key,
  last_no integer not null default 0
);

create table public.receipts (
  id          uuid primary key default gen_random_uuid(),
  receipt_no  text not null unique,
  year        integer not null,
  seq         integer not null,
  order_id    uuid not null unique references public.orders (id) on delete cascade,
  customer_id uuid references public.profiles (id) on delete set null,
  issued_at   timestamptz not null default now(),
  seller      jsonb not null,
  lines       jsonb not null,
  vat         numeric(10,3) not null,
  total       numeric(10,3) not null,
  unique (year, seq)
);
create index receipts_customer_idx on public.receipts (customer_id, issued_at desc);

alter table public.receipt_counters enable row level security;
alter table public.receipts enable row level security;
revoke all on public.receipt_counters, public.receipts from anon, authenticated;
grant select on public.receipts to authenticated;
create policy receipts_own on public.receipts for select to authenticated using (customer_id = auth.uid() or public.is_staff());

-- The next number of a year's sequence (row-locked counter: no gaps, no repeats).
create function public.next_receipt_seq(p_year integer)
returns integer
language sql security definer set search_path = public
as $$
  insert into public.receipt_counters as c (year, last_no) values (p_year, 1)
  on conflict (year) do update set last_no = c.last_no + 1
  returning last_no
$$;

-- Issue the receipt of a delivered household order (idempotent: one per order).
create function public.issue_receipt(p_order uuid, p_notify boolean default true)
returns public.receipts
language plpgsql security definer set search_path = public
as $$
declare o public.orders; rc public.receipts; y integer; n integer;
begin
  select * into rc from public.receipts where order_id = p_order;
  if found then return rc; end if;
  select * into o from public.orders where id = p_order;
  if not found or o.status <> 'delivered' or o.org_id is not null or o.billing <> 'prepaid' or o.customer_id is null then return null; end if;
  y := extract(year from (coalesce(o.delivered_at, now()) at time zone 'Asia/Muscat'))::integer;
  n := public.next_receipt_seq(y);
  insert into public.receipts (receipt_no, year, seq, order_id, customer_id, issued_at, seller, lines, vat, total)
  values ('RCT-' || y || '-' || lpad(n::text, 6, '0'), y, n, o.id, o.customer_id, coalesce(o.delivered_at, now()),
          coalesce(public.setting_json('SELLER'), '{}'::jsonb),
          jsonb_build_object('water_charge', o.water_charge, 'delivery_fee', o.delivery_fee, 'discount', o.discount, 'vat', o.vat,
                             'total', o.total, 'short_credit', o.short_credit, 'tip', o.tip,
                             'vat_rate', coalesce((o.price_basis ->> 'vat_rate')::numeric, public.rule_num('vat_rate')),
                             'gallons_ordered', o.gallons, 'service_type', o.service_type,
                             'tariff', o.price_basis -> 'tariff', 'delivery', o.price_basis -> 'delivery'),
          o.vat, o.total - coalesce(o.short_credit, 0))
  returning * into rc;
  if p_notify then
    perform public.notify(o.customer_id, 'receipt_ready', o.id,
      jsonb_build_object('order', 'TO-' || o.order_no, 'receipt', rc.receipt_no, 'total', to_char(rc.total, 'FM9990.000')));
  end if;
  return rc;
end $$;

create function public.orders_issue_receipt()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' and new.org_id is null and new.billing = 'prepaid' then
    perform public.issue_receipt(new.id, true);
  end if;
  return new;
end $$;
create trigger orders_issue_receipt after update of status on public.orders
  for each row execute function public.orders_issue_receipt();

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('receipt_ready', 'E-receipt ready', 'customer', 'Your receipt is ready', 'Receipt {receipt} for {order}: {total} OMR. Open it to share or print.',
   'إيصالك جاهز', 'الإيصال {receipt} للطلب {order}: {total} ر.ع. افتحه للمشاركة أو الطباعة.', true, false, false, true, 'service', false)
on conflict (event) do nothing;

-- Earlier deliveries, numbered in delivery order (no notifications).
do $$
declare o record;
begin
  for o in select id from public.orders where status = 'delivered' and org_id is null and billing = 'prepaid' and customer_id is not null
            order by delivered_at nulls first, order_no loop
    perform public.issue_receipt(o.id, false);
  end loop;
end $$;

-- Everything the receipt page shows, for the order's customer or NWS staff.
create function public.order_receipt(p_order_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare o public.orders; rc public.receipts; pay public.payments; pd public.pods; cu public.profiles;
begin
  select * into o from public.orders where id = p_order_id;
  if not found or not (o.customer_id = auth.uid() or public.is_staff()) then raise exception 'not_found'; end if;
  select * into rc from public.receipts where order_id = o.id;
  if not found then raise exception 'receipt_not_ready'; end if;
  select * into pay from public.payments where order_id = o.id order by created_at desc limit 1;
  select * into pd from public.pods where order_id = o.id;
  select * into cu from public.profiles where id = o.customer_id;
  return jsonb_build_object(
    'receipt', to_jsonb(rc),
    'order', jsonb_build_object('id', o.id, 'order_no', o.order_no, 'service_type', o.service_type, 'gallons', o.gallons, 'area', o.area,
                                'created_at', o.created_at, 'delivered_at', o.delivered_at, 'driver_name', o.driver_name, 'tanker_plate', o.tanker_plate,
                                'is_test', o.is_test, 'promo_code', o.promo_code, 'pay_method', o.pay_method, 'payment_status', o.payment_status),
    'customer', jsonb_build_object('name', cu.full_name, 'phone', public.mask_phone(cu.phone)),
    'payment', case when pay.id is null then null else jsonb_build_object('method', pay.method, 'amount', pay.amount, 'wallet_amount', pay.wallet_amount,
                                                                         'card_amount', pay.card_amount, 'card_last4', pay.card_last4, 'status', pay.status,
                                                                         'gateway_ref', pay.gateway_ref, 'refunded_amount', pay.refunded_amount,
                                                                         'captured_at', pay.captured_at, 'created_at', pay.created_at) end,
    'pod', case when pd.order_id is null then null else jsonb_build_object('kind', pd.kind, 'meter_gal', pd.meter_gal, 'at', pd.created_at,
                                                                          'photo', pd.photo_path is not null, 'signed', pd.signature_path is not null or pd.signature_svg is not null,
                                                                          'no_signature', pd.no_signature, 'left_at_tank', pd.left_at_tank, 'status', pd.status) end,
    'vat_pending', coalesce((select status <> 'confirmed' from public.pricing_rules where rule_key = 'vat_rate'), true));
end $$;

-- ===========================================================================
-- #6 business invoices ready for Fawtara (PEPPOL / UBL 2.1)
-- ===========================================================================
alter table public.invoices
  add column type_code    text not null default '380' check (type_code in ('380', '381', '383', '386')),
  add column currency     text not null default 'OMR' check (currency = 'OMR'),
  add column seller_name  text,
  add column seller_vatin text,
  add column buyer_name   text,
  add column buyer_cr     text,
  add column buyer_vatin  text,
  add column vat_rate     numeric(6,4);

create table public.invoice_lines (
  invoice_id   uuid not null references public.invoices (id) on delete cascade,
  line_no      integer not null check (line_no >= 1),
  order_id     uuid references public.orders (id) on delete set null,
  description  text not null,
  item_code    text not null,
  quantity     numeric(12,3) not null check (quantity >= 0),
  unit_code    text not null default 'GLL',
  net_amount   numeric(12,3) not null,
  vat_category text not null default 'S' check (vat_category in ('S', 'Z', 'E', 'O')),
  vat_rate     numeric(6,4) not null,
  vat_amount   numeric(12,3) not null,
  line_total   numeric(12,3) not null,
  primary key (invoice_id, line_no)
);

alter table public.invoice_lines enable row level security;
revoke all on public.invoice_lines from anon, authenticated;
grant select on public.invoice_lines to authenticated;
create policy invoice_lines_read on public.invoice_lines for select to authenticated using (
  public.is_staff() or exists (select 1 from public.invoices i where i.id = invoice_lines.invoice_id and i.org_id = public.my_org_id() and not public.my_sites_restricted()));

-- Lines of an invoice from its orders (one per order: net = total − VAT − short-delivery credit).
create function public.fill_invoice_lines(p_invoice uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer;
begin
  delete from public.invoice_lines where invoice_id = p_invoice;
  insert into public.invoice_lines (invoice_id, line_no, order_id, description, item_code, quantity, unit_code, net_amount, vat_category, vat_rate, vat_amount, line_total)
  select p_invoice, row_number() over (order by o.delivered_at, o.order_no), o.id,
         case o.service_type when 'DW' then 'Drinking water delivery' when 'WW' then 'Wastewater collection' else 'Treated effluent delivery' end
           || ' TO-' || o.order_no || case when coalesce(o.short_credit, 0) > 0 then ' (short-delivery credit applied)' else '' end,
         'TANKER-' || o.service_type, o.gallons, 'GLL',
         o.total - o.vat - coalesce(o.short_credit, 0), 'S',
         coalesce((o.price_basis ->> 'vat_rate')::numeric, public.rule_num('vat_rate')), o.vat,
         o.total - coalesce(o.short_credit, 0)
    from public.orders o where o.invoice_id = p_invoice;
  get diagnostics n = row_count;
  return n;
end $$;

-- 0020 body, plus the e-invoice fields and lines.
create or replace function public.invoice_org(p_org uuid)
returns public.invoices
language plpgsql security definer set search_path = public
as $$
declare inv public.invoices; org public.organizations; ids uuid[]; n integer; v numeric; tot numeric; first_at timestamptz; seller jsonb := public.setting_json('SELLER');
begin
  select * into org from public.organizations where id = p_org for update;
  select array_agg(id) into ids from (
    select id from public.orders where org_id = p_org and billing = 'account' and status = 'delivered' and invoice_id is null and not is_test for update) x;
  if ids is null then raise exception 'nothing_to_invoice'; end if;
  select count(*), coalesce(sum(vat), 0), coalesce(sum(total - short_credit), 0), min(delivered_at)
    into n, v, tot, first_at
    from public.orders where id = any(ids);
  insert into public.invoices (org_id, period_start, period_end, orders, subtotal, vat, total, due_at,
                               seller_name, seller_vatin, buyer_name, buyer_cr, buyer_vatin, vat_rate)
  values (p_org, first_at::date, current_date, n, tot - v, v, tot, now() + make_interval(days => org.terms_days),
          coalesce(seller ->> 'name_en', 'Nama Water Services'), nullif(seller ->> 'vat_number', ''), org.name, org.cr_no, org.vat_number,
          public.rule_num('vat_rate'))
  returning * into inv;
  update public.orders set invoice_id = inv.id where id = any(ids);
  perform public.fill_invoice_lines(inv.id);
  perform public.notify(m.id, 'invoice_issued', null, jsonb_build_object('invoice', 'INV-' || inv.invoice_no, 'amount', to_char(tot, 'FM99990.000')))
     from public.profiles m where m.org_id = p_org and m.org_role in ('admin', 'finance');
  return inv;
end $$;

-- Existing invoices: the same fields from today's settings, and their lines.
update public.invoices i
   set seller_name = coalesce(public.setting_json('SELLER') ->> 'name_en', 'Nama Water Services'),
       seller_vatin = nullif(public.setting_json('SELLER') ->> 'vat_number', ''),
       buyer_name = g.name, buyer_cr = g.cr_no, buyer_vatin = g.vat_number,
       vat_rate = public.rule_num('vat_rate')
  from public.organizations g
 where g.id = i.org_id and i.buyer_name is null;
do $$
declare i record;
begin
  for i in select id from public.invoices loop perform public.fill_invoice_lines(i.id); end loop;
end $$;

-- ===========================================================================
-- #7 payments confirm at once (simulated gateway), live on the customer screens
-- ===========================================================================
alter table public.payments drop constraint payments_status_check;
alter table public.payments add constraint payments_status_check
  check (status in ('pending', 'authorized', 'captured', 'refunded', 'partially_refunded', 'failed', 'on_account'));
alter table public.orders drop constraint orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('pending', 'authorized', 'captured', 'refunded', 'partially_refunded', 'failed', 'on_account'));
alter table public.payments add column confirmed_at timestamptz;
update public.payments set confirmed_at = coalesce(captured_at, created_at) where status not in ('pending', 'failed') and confirmed_at is null;

create sequence public.topups_no_seq as bigint start with 10001;
create table public.topups (
  id             uuid primary key default gen_random_uuid(),
  topup_no       bigint not null unique default nextval('public.topups_no_seq'),
  customer_id    uuid not null references public.profiles (id) on delete cascade,
  amount         numeric(10,3) not null check (amount > 0),
  method         text not null check (method in ('card', 'omannet')),
  card_last4     text check (card_last4 ~ '^[0-9]{4}$'),
  status         text not null check (status in ('pending', 'confirmed', 'failed')),
  gateway_ref    text not null,
  failure_reason text,
  wallet_tx_id   bigint references public.wallet_tx (id) on delete set null,
  created_at     timestamptz not null default now(),
  confirmed_at   timestamptz
);
create index topups_customer_idx on public.topups (customer_id, created_at desc);
create index topups_pending_idx on public.topups (created_at) where status = 'pending';

alter table public.topups enable row level security;
revoke all on public.topups from anon, authenticated;
revoke all on sequence public.topups_no_seq from anon, authenticated;
grant select on public.topups to authenticated;
create policy topups_own on public.topups for select to authenticated using (customer_id = auth.uid() or public.is_staff());

-- Credit a top-up to the wallet (once).
create function public.credit_topup(p_id uuid)
returns public.topups
language plpgsql security definer set search_path = public
as $$
declare tu public.topups; tx bigint;
begin
  select * into tu from public.topups where id = p_id for update;
  if not found or tu.status <> 'pending' then return tu; end if;
  perform public.lock_wallet(tu.customer_id);
  insert into public.wallet_tx (customer_id, kind, amount, memo)
  values (tu.customer_id, 'topup', tu.amount,
          case when tu.method = 'omannet' then 'OmanNet top-up' else 'Card top-up ••' || coalesce(tu.card_last4, '4417') end || ' · TU-' || tu.topup_no)
  returning id into tx;
  update public.topups set status = 'confirmed', confirmed_at = now(), wallet_tx_id = tx where id = tu.id returning * into tu;
  return tu;
end $$;

-- Simulated gateway: confirmed at once, except card 0002 (declined) and 0003 (the gateway
-- answers later: pending until confirm_simulated_payments). Returns the wallet plus the top-up.
create or replace function public.wallet_topup(p_amount numeric, p_method text default 'card', p_card_last4 text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare amt numeric := round(coalesce(p_amount, 0), 3); tu public.topups; last4 text;
begin
  if public.my_role() is distinct from 'customer' then raise exception 'not_a_customer'; end if;
  if amt < 1 or amt > 500 then raise exception 'invalid_amount'; end if;
  if p_method not in ('card', 'omannet') then raise exception 'invalid_payment_method'; end if;
  if coalesce(p_card_last4, '') = '0002' then raise exception 'payment_failed'; end if;
  last4 := case when p_card_last4 ~ '^[0-9]{4}$' then p_card_last4 when p_method = 'card' then '4417' end;
  insert into public.topups (customer_id, amount, method, card_last4, status, gateway_ref)
  values (auth.uid(), amt, p_method, last4, 'pending', 'SIM-TU')
  returning * into tu;
  update public.topups set gateway_ref = 'SIM-TU-' || tu.topup_no where id = tu.id returning * into tu;
  if coalesce(p_card_last4, '') <> '0003' then
    tu := public.credit_topup(tu.id);
  end if;
  return public.my_wallet() || jsonb_build_object('topup', to_jsonb(tu));
end $$;

-- A pending order payment, once the gateway answers: authorised (captured if the order is
-- already delivered); if the order was cancelled meanwhile, the money goes back.
create function public.confirm_order_payment(p_payment uuid)
returns public.payments
language plpgsql security definer set search_path = public
as $$
declare pay public.payments; o public.orders;
begin
  select * into pay from public.payments where id = p_payment for update;
  if not found or pay.status <> 'pending' then return pay; end if;
  select * into o from public.orders where id = pay.order_id for update;
  update public.payments
     set status = case when o.status = 'delivered' then 'captured' else 'authorized' end, confirmed_at = now(),
         captured_at = case when o.status = 'delivered' then now() else captured_at end
   where id = pay.id returning * into pay;
  update public.orders set payment_status = pay.status where id = o.id;
  if o.status = 'cancelled' then
    perform public.refund_to_wallet(o.id, o.total - coalesce(o.cancel_fee, 0), 'refund', 'Cancelled TO-' || o.order_no || ' (payment confirmed late)');
    select * into pay from public.payments where id = pay.id;
  end if;
  return pay;
end $$;

-- pg_cron, every minute: the simulated gateway answers pending payments after 20 seconds.
create function public.confirm_simulated_payments()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare r record; t integer := 0; p integer := 0;
begin
  if auth.uid() is not null then perform public.require_staff(array['finance']::public.staff_role[]); end if;
  for r in select id from public.topups where status = 'pending' and gateway_ref like 'SIM-%' and created_at < now() - interval '20 seconds' loop
    perform public.credit_topup(r.id); t := t + 1;
  end loop;
  for r in select id from public.payments where status = 'pending' and coalesce(gateway_ref, '') like 'SIM-%' and created_at < now() - interval '20 seconds' loop
    perform public.confirm_order_payment(r.id); p := p + 1;
  end loop;
  return jsonb_build_object('topups', t, 'payments', p);
end $$;

-- Card payments are confirmed at once (0015 body via create_order_core); card 0003 simulates
-- a gateway that answers later: the order is placed and dispatched, the payment is pending.
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
declare o public.orders;
begin
  perform set_config('nama.pricing_point', case when p_lat is not null and p_lng is not null then p_lat::text || ',' || p_lng::text else '' end, true);
  o := public.create_order_core(p_service_type, p_gallons, p_lat, p_lng, p_area, p_address, p_property_id, p_slot_start, p_slot_end,
                                p_slot_label, p_emergency, p_driver_note, p_pay_method, p_card_last4, p_promo_code);
  perform set_config('nama.pricing_point', '', true);
  update public.payments set confirmed_at = now() where order_id = o.id and status = 'authorized' and confirmed_at is null;
  if coalesce(p_card_last4, '') = '0003' and o.payment_status = 'authorized' then
    update public.payments set status = 'pending', confirmed_at = null where order_id = o.id and status = 'authorized' and card_amount > 0;
    if found then
      update public.orders set payment_status = 'pending' where id = o.id returning * into o;
    end if;
  end if;
  return o;
end $$;

select public.nama_schedule('nama-confirm-payments', '* * * * *', 'select public.confirm_simulated_payments()');

do $$
declare t text;
begin
  foreach t in array array['payments', 'topups', 'wallet_tx'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ===========================================================================
-- Execute rights
-- ===========================================================================
revoke execute on function
  public.next_receipt_seq(integer), public.issue_receipt(uuid, boolean), public.orders_issue_receipt(),
  public.fill_invoice_lines(uuid), public.credit_topup(uuid), public.confirm_order_payment(uuid)
from public, anon, authenticated;
revoke execute on function public.normalize_vatin(text) from public, anon;
grant execute on function public.normalize_vatin(text) to authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'staff_update_seller(jsonb, text)', 'org_set_vat_number(text)', 'staff_set_org_vat_number(uuid, text, text)',
    'order_receipt(uuid)', 'wallet_topup(numeric, text, text)', 'confirm_simulated_payments()']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
