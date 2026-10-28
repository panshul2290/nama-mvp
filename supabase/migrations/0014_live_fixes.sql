-- Fixes found while testing against the live project.

-- Contract orders can be generated for one contract: accepting a contract
-- schedules that contract's deliveries only (no side effects on others).
create function public.generate_contract_orders(p_contract uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare c record; d date; n integer := 0; step interval; s timestamptz; o public.orders;
begin
  for c in select k.*, p.lat, p.lng, p.area, p.address from public.contracts k join public.properties p on p.id = k.property_id
            where k.status = 'active' and k.end_date >= current_date and (p_contract is null or k.id = p_contract) loop
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

-- The periodic form still covers every active contract (staff_scan, seed).
create or replace function public.generate_contract_orders()
returns integer
language sql security definer set search_path = public
as $$ select public.generate_contract_orders(null::uuid) $$;

create or replace function public.owner_decide_contract(p_contract_id uuid, p_accept boolean)
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
  if p_accept then perform public.generate_contract_orders(c.id); end if;
  return c;
end $$;

revoke execute on function public.generate_contract_orders(uuid), public.generate_contract_orders() from public, anon, authenticated;
