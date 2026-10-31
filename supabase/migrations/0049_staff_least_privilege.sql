-- 0049: staff least privilege for personal data (security review SEC-04).
--
-- Every staff sub-role, viewer included, could read raw phone numbers, exact delivery addresses,
-- identity-document scans, evidence files and live-route share tokens straight from the API
-- (the masking was in the UI only). Now, enforced in the database:
--
--   * Raw phone numbers are no longer a selectable column for anyone. profiles.phone_masked
--     (a generated column) is readable wherever the row is; the raw number comes only from
--     contact_phones(ids), which applies the same visibility rules as the profiles policies
--     (the person, a driver on that customer's job, the company owner for its drivers and
--     contract customers, organisation members) and, for staff, gives raw numbers only to the
--     roles that phone people: admin, operator, complaints_agent, permit_officer, inspector.
--     viewer and finance get masked numbers. Staff look people up by name or number with
--     staff_find_people (matched on the raw number in the database, returned masked).
--   * Exact delivery points and address details (order_locations): staff roles that work with
--     deliveries (admin, operator, complaints_agent, permit_officer, inspector); not viewer or
--     finance.
--   * Identity documents (rows and the identity bucket): admin, permit_officer, inspector.
--   * Evidence files (POD photos, complaint photos, tanker documents): the uploader, the parties
--     that may see the record, and the delivery-facing staff roles above; not viewer or finance.
--   * Live-route share tokens: only the driver who made them (no staff read).
-- Follow-up (documented): enforce profiles.staff_zones per zone; read-audit of bulk views.

create function public.staff_pii_role()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce(public.my_staff_role() in ('admin', 'operator', 'complaints_agent', 'permit_officer', 'inspector'), false) $$;

create function public.staff_kyc_role()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce(public.my_staff_role() in ('admin', 'permit_officer', 'inspector'), false) $$;

-- ===========================================================================
-- Phones
-- ===========================================================================
alter table public.profiles add column phone_masked text generated always as (public.mask_phone(phone)) stored;
revoke select (phone) on public.profiles from authenticated;
grant select (phone_masked) on public.profiles to authenticated;

-- May the caller see this person's raw number? The profiles policies (0001, 0011, 0008), with
-- the staff part narrowed to the roles that phone people.
create function public.can_see_raw_phone(p public.profiles)
returns boolean
language sql stable security definer set search_path = public
as $$
  select auth.uid() is not null and (
    p.id = auth.uid()
    or (public.is_staff() and public.staff_pii_role())
    or (not public.is_staff() and (
      exists (select 1 from public.orders o where o.customer_id = p.id and o.driver_id = auth.uid() and o.status in ('accepted', 'arriving', 'arrived', 'collected'))
      or (public.is_owner() and p.company_id is not null and p.company_id = public.my_company_id())
      or (public.is_owner() and exists (select 1 from public.contracts k where k.customer_id = p.id and k.company_id = public.my_company_id()))
      or (p.org_id is not null and p.org_id = public.my_org_id()))))
$$;

-- Raw numbers for the people the caller may see (masked for viewer/finance staff); people the
-- caller can't see at all are left out.
create function public.contact_phones(p_ids uuid[])
returns table (id uuid, phone text)
language sql stable security definer set search_path = public
as $$
  select p.id, case when public.can_see_raw_phone(p) then p.phone else p.phone_masked end
    from public.profiles p
   where p.id = any(coalesce(p_ids, '{}'::uuid[])) and cardinality(p_ids) <= 500
     and (public.can_see_raw_phone(p) or public.is_staff())
$$;

-- NWS: find customers (or other people) by name or mobile number; numbers come back masked.
create function public.staff_find_people(p_q text, p_roles public.user_role[] default null, p_limit integer default 8)
returns table (id uuid, full_name text, phone_masked text, role public.user_role, account_blocked boolean)
language plpgsql stable security definer set search_path = public
as $$
declare q text := btrim(coalesce(p_q, '')); digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  if char_length(q) < 2 then return; end if;
  return query
    select p.id, p.full_name, p.phone_masked, p.role, p.account_blocked
      from public.profiles p
     where (p_roles is null or p.role = any(p_roles))
       and (p.full_name ilike '%' || replace(replace(q, '%', ''), '_', '') || '%'
            or (char_length(digits) >= 4 and regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') like '%' || digits || '%'))
     order by p.full_name
     limit least(greatest(coalesce(p_limit, 8), 1), 50);
end $$;

-- ===========================================================================
-- Exact delivery points and address details
-- ===========================================================================
drop policy order_locations_staff_select on public.order_locations;
create policy order_locations_staff_select on public.order_locations for select to authenticated using (public.staff_pii_role());

-- ===========================================================================
-- Identity documents
-- ===========================================================================
drop policy identity_documents_staff on public.identity_documents;
create policy identity_documents_staff on public.identity_documents for select to authenticated using (public.staff_kyc_role());

-- ===========================================================================
-- Live-route share tokens: the driver's only
-- ===========================================================================
drop policy route_shares_staff on public.route_shares;

-- ===========================================================================
-- Storage (Supabase only — PGlite has no storage schema)
-- ===========================================================================
do $$
begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists identity_read on storage.objects';
    execute $p$create policy identity_read on storage.objects for select to authenticated
      using (bucket_id = 'identity' and ((storage.foldername(name))[1] = auth.uid()::text or public.staff_kyc_role()))$p$;
    execute 'drop policy if exists evidence_read on storage.objects';
    execute $p$create policy evidence_read on storage.objects for select to authenticated using (
      bucket_id = 'evidence' and (
        (storage.foldername(name))[1] = auth.uid()::text
        or public.staff_pii_role()
        or (not public.is_staff() and (
              exists (select 1 from public.pods d where d.photo_path = storage.objects.name)
           or exists (select 1 from public.complaints c where c.photo_path = storage.objects.name)
           or exists (select 1 from public.tanker_documents t where t.file_path = storage.objects.name)))))$p$;
  end if;
end $$;

revoke execute on function public.staff_pii_role(), public.staff_kyc_role(), public.can_see_raw_phone(public.profiles),
  public.contact_phones(uuid[]), public.staff_find_people(text, public.user_role[], integer) from public, anon;
grant execute on function public.staff_pii_role(), public.staff_kyc_role(), public.can_see_raw_phone(public.profiles),
  public.contact_phones(uuid[]), public.staff_find_people(text, public.user_role[], integer) to authenticated;
