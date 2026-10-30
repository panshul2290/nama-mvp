-- Batch D (part 2 of 3): bulk import of the NWS tanker register.
--
--   registry_owners  owners named in the register. They are NOT sign-in accounts: a row has a
--                    name, a mobile number (E.164, when the register has a usable one), a
--                    governorate and, once they sign up, the profile and company that claimed it.
--                    Claiming is by verified mobile number only (auth.users.phone with
--                    phone_confirmed_at), never by the editable profile phone.
--   import_batches   one row per import: file name, counts, and the error report (row, plate,
--                    level, field, message) that NWS → Permits → Register downloads as CSV.
--   staff_import_batch_start / staff_import_register / staff_import_batch_finish
--                    the importer's three calls. Rows arrive in chunks of at most 500
--                    (NWS → Permits → Register → Import register, or scripts/import-register.mjs).
--                    The database re-validates every row (lib/importRegister.ts applies the same
--                    rules in the browser for the preview) and is idempotent by plate:
--                      tanker   created (offline, no driver, on_platform = false, capacity
--                               5,000 gal placeholder with capacity_known = false) or updated
--                      owner    matched on mobile number, else on name + governorate
--                      permit   Valid → an approved permit with its number and dates;
--                               In Progress → a pending application at the submitted stage;
--                               No Permit → none
--                    Re-running the same file changes nothing but the "updated" counts.
--   Claiming         when a registry owner signs up and verifies the same mobile number, the
--                    owner row links to the profile; an owner account with a company takes
--                    over its register tankers (they join the company, on the platform). A
--                    driver or owner registering a plate that is in the register adopts that
--                    tanker instead of failing with plate_taken, if the verified number matches
--                    the register (or the register has no number for it).
-- Only staff (and the claiming owner, through RPCs) ever see registry owners; phones are
-- masked on screens for non-privileged roles (0027) by the list RPC (0033).

-- ===========================================================================
-- Tables
-- ===========================================================================
create table public.import_batches (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null default 'tanker_register' check (kind in ('tanker_register')),
  file_name    text not null check (char_length(file_name) between 1 and 200),
  source       text not null default 'upload' check (source in ('upload', 'script')),
  status       text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  total_rows   integer not null default 0 check (total_rows >= 0),
  -- The browser's validation summary (rows ok / with warnings / with errors, duplicates).
  summary      jsonb not null default '{}'::jsonb,
  -- Server-side counts, added up chunk by chunk.
  counts       jsonb not null default '{}'::jsonb,
  -- Error report: [{row, plate, level, field, message}], browser and server issues together.
  errors       jsonb not null default '[]'::jsonb,
  chunks       integer not null default 0,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index import_batches_created_idx on public.import_batches (created_at desc);

create table public.registry_owners (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (char_length(name) between 1 and 120),
  name_key         text not null,
  phone            text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  governorate_code text references public.governorates (code) on update cascade,
  -- Set when the owner signs up with this verified number (and registers a company).
  profile_id       uuid references public.profiles (id) on delete set null,
  company_id       uuid references public.companies (id) on delete set null,
  claimed_at       timestamptz,
  -- SMS invitations (0033).
  invited_at       timestamptz,
  invite_count     integer not null default 0,
  sms_opt_out      boolean not null default false,
  opted_out_at     timestamptz,
  first_batch_id   uuid references public.import_batches (id) on delete set null,
  batch_id         uuid references public.import_batches (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index registry_owners_phone_uq on public.registry_owners (phone) where phone is not null;
create unique index registry_owners_name_uq on public.registry_owners (name_key, governorate_code) where phone is null;
create index registry_owners_profile_idx on public.registry_owners (profile_id) where profile_id is not null;
create index registry_owners_gov_idx on public.registry_owners (governorate_code);

alter table public.tankers
  add column registry_owner_id      uuid references public.registry_owners (id) on delete set null,
  add column register_permit_status text check (register_permit_status in ('none', 'in_progress', 'valid')),
  add column register_permit_no     text,
  add column register_row           integer,
  add column import_batch_id        uuid references public.import_batches (id) on delete set null,
  add column register_updated_at    timestamptz;
create index tankers_registry_owner_idx on public.tankers (registry_owner_id) where registry_owner_id is not null;
-- Lookups by the normalised plate (the register writes "1798 ML", an app may have stored "1798ML").
create index tankers_plate_norm_idx on public.tankers (public.normalize_plate(plate));

-- ===========================================================================
-- Value helpers (the same rules as lib/importRegister.ts)
-- ===========================================================================
create function public.register_service_type(p text)
returns public.service_type
language sql immutable
as $$
  select case regexp_replace(lower(btrim(coalesce(p, ''))), '\s+', ' ', 'g')
    when 'drinking water' then 'DW' when 'dw' then 'DW' when 'potable water' then 'DW'
    when 'sewage water' then 'WW' when 'sewage' then 'WW' when 'ww' then 'WW' when 'wastewater' then 'WW' when 'waste water' then 'WW'
    when 'treated effluent' then 'TE' when 'te' then 'TE' when 'tse' then 'TE'
  end::public.service_type
$$;

create function public.register_permit_status(p text)
returns text
language sql immutable
as $$
  select case regexp_replace(lower(btrim(coalesce(p, ''))), '[\s_-]+', ' ', 'g')
    when 'valid' then 'valid' when 'approved' then 'valid'
    when 'in progress' then 'in_progress' when 'pending' then 'in_progress'
    when 'no permit' then 'none' when 'none' then 'none' when '' then 'none'
  end
$$;

-- YYYY-MM-DD (or a date Postgres reads unambiguously) → date; null when empty or invalid.
create function public.register_date(p text)
returns date
language plpgsql immutable
as $$
begin
  if nullif(btrim(coalesce(p, '')), '') is null or lower(btrim(p)) = 'null' then return null; end if;
  if btrim(p) !~ '^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}$' then return null; end if;
  return btrim(p)::date;
exception when others then return null;
end $$;

-- ===========================================================================
-- Import RPCs (permit officers; admin passes every check)
-- ===========================================================================
create function public.staff_import_batch_start(p_file_name text, p_total integer, p_summary jsonb default '{}'::jsonb, p_source text default 'upload')
returns public.import_batches
language plpgsql security definer set search_path = public
as $$
declare b public.import_batches;
begin
  perform public.require_staff(array['permit_officer']::public.staff_role[]);
  if coalesce(p_total, 0) < 1 or p_total > 100000 then raise exception 'invalid_import: 1 to 100,000 rows'; end if;
  insert into public.import_batches (file_name, source, total_rows, summary, created_by)
  values (left(coalesce(nullif(btrim(p_file_name), ''), 'register.csv'), 200), case when p_source = 'script' then 'script' else 'upload' end,
          p_total, coalesce(p_summary, '{}'::jsonb), auth.uid())
  returning * into b;
  perform public.write_audit('register.import_start', 'import_batch', b.id::text, null,
                             jsonb_build_object('file', b.file_name, 'rows', b.total_rows, 'source', b.source, 'summary', b.summary), null);
  return b;
end $$;

-- One chunk (at most 500 rows). Each row: {row, plate, owner, service_type, governorate, cluster,
-- phone, permit_status, permit_no, issued, expires} as the file has them (or already normalised).
-- Returns {counts: {...}, issues: [{row, plate, level, field, message}]}.
create function public.staff_import_register(p_rows jsonb, p_batch_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  b public.import_batches; r jsonb; rn integer; raw_plate text; pl text; svc public.service_type; gov text; gov_cluster text; cl text;
  ph text; raw_ph text; owner_name text; okey text; pst text; pno text; d_iss date; d_exp date;
  oid uuid; o_new boolean; ex public.tankers; tk public.tankers; ep public.permits; app_no text; bad boolean;
  issues jsonb := '[]'::jsonb;
  c_rows integer := 0; c_err integer := 0; c_warn integer := 0; c_tk_new integer := 0; c_tk_upd integer := 0; c_own_new integer := 0; c_own_match integer := 0;
  c_perm integer := 0; c_app integer := 0; c_perm_have integer := 0; c_no_owner integer := 0; c_no_phone integer := 0;
  v_counts jsonb;
begin
  perform public.require_staff(array['permit_officer']::public.staff_role[]);
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'invalid_import: rows must be an array'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'chunk_too_large: at most 500 rows per call'; end if;
  select * into b from public.import_batches where id = p_batch_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.status <> 'running' then raise exception 'invalid_state: the import is %', b.status; end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    c_rows := c_rows + 1;
    bad := false;
    rn := case when (r ->> 'row') ~ '^[0-9]{1,7}$' then (r ->> 'row')::integer end;
    raw_plate := left(btrim(coalesce(r ->> 'plate', '')), 40);
    pl := public.normalize_plate(raw_plate);
    if pl is null or char_length(pl) < 2 then
      issues := issues || jsonb_build_object('row', rn, 'plate', raw_plate, 'level', 'error', 'field', 'plate', 'message', 'Not a plate number (digits, then up to two letters)');
      c_err := c_err + 1; continue;
    end if;
    svc := public.register_service_type(r ->> 'service_type');
    if svc is null then
      issues := issues || jsonb_build_object('row', rn, 'plate', pl, 'level', 'error', 'field', 'tanker_type', 'message', 'Unknown tanker type: ' || left(coalesce(r ->> 'service_type', ''), 40));
      c_err := c_err + 1; continue;
    end if;
    gov := public.governorate_code(r ->> 'governorate');
    if gov is null then
      issues := issues || jsonb_build_object('row', rn, 'plate', pl, 'level', 'error', 'field', 'governorate', 'message', 'Unknown governorate: ' || left(coalesce(r ->> 'governorate', ''), 40));
      c_err := c_err + 1; continue;
    end if;
    pst := public.register_permit_status(r ->> 'permit_status');
    if pst is null then
      issues := issues || jsonb_build_object('row', rn, 'plate', pl, 'level', 'error', 'field', 'permit_status', 'message', 'Unknown permit status: ' || left(coalesce(r ->> 'permit_status', ''), 40));
      c_err := c_err + 1; continue;
    end if;

    begin
      -- Cluster: the governorate decides; a row that says otherwise is reported.
      select cluster_code into gov_cluster from public.governorates where code = gov;
      cl := public.cluster_code(r ->> 'cluster');
      if nullif(btrim(coalesce(r ->> 'cluster', '')), '') is not null and (cl is null or cl is distinct from gov_cluster) then
        issues := issues || jsonb_build_object('row', rn, 'plate', pl, 'level', 'warning', 'field', 'cluster',
                                               'message', format('Cluster "%s" differs from the governorate''s cluster (%s); the governorate''s is used', left(r ->> 'cluster', 20), coalesce(gov_cluster, 'none')));
        bad := true;
      end if;

      raw_ph := btrim(coalesce(r ->> 'phone', ''));
      ph := case when raw_ph = '' or lower(raw_ph) = 'null' then null else public.normalize_phone(raw_ph) end;
      if ph is null and raw_ph <> '' and lower(raw_ph) <> 'null' then
        issues := issues || jsonb_build_object('row', rn, 'plate', pl, 'level', 'warning', 'field', 'contact', 'message', 'Not a valid mobile number; treated as missing');
        bad := true;
      end if;
      if ph is null then c_no_phone := c_no_phone + 1; end if;

      -- Owner: by mobile number, else by name within the governorate.
      owner_name := left(btrim(regexp_replace(coalesce(r ->> 'owner', ''), '\s+', ' ', 'g')), 120);
      oid := null; o_new := false;
      if owner_name <> '' and lower(owner_name) <> 'null' then
        okey := lower(owner_name);
        if ph is not null then
          insert into public.registry_owners (name, name_key, phone, governorate_code, first_batch_id, batch_id)
          values (owner_name, okey, ph, gov, p_batch_id, p_batch_id)
          on conflict (phone) where phone is not null do update
             set name = case when registry_owners.batch_id is distinct from excluded.batch_id then excluded.name else registry_owners.name end,
                 name_key = case when registry_owners.batch_id is distinct from excluded.batch_id then excluded.name_key else registry_owners.name_key end,
                 governorate_code = coalesce(registry_owners.governorate_code, excluded.governorate_code),
                 batch_id = excluded.batch_id, updated_at = now()
          returning id, (xmax = 0) into oid, o_new;
        else
          insert into public.registry_owners (name, name_key, governorate_code, first_batch_id, batch_id)
          values (owner_name, okey, gov, p_batch_id, p_batch_id)
          on conflict (name_key, governorate_code) where phone is null do update
             set batch_id = excluded.batch_id, updated_at = now()
          returning id, (xmax = 0) into oid, o_new;
        end if;
        if o_new then c_own_new := c_own_new + 1; else c_own_match := c_own_match + 1; end if;
      else
        c_no_owner := c_no_owner + 1;
        issues := issues || jsonb_build_object('row', rn, 'plate', pl, 'level', 'warning', 'field', 'owner', 'message', 'No owner name');
        bad := true;
      end if;

      pno := nullif(upper(btrim(coalesce(r ->> 'permit_no', ''))), '');
      if lower(coalesce(pno, '')) = 'null' then pno := null; end if;
      d_iss := public.register_date(r ->> 'issued');
      d_exp := public.register_date(r ->> 'expires');

      -- Tanker, idempotent by plate.
      select * into ex from public.tankers where public.normalize_plate(plate) = pl order by on_platform desc, created_at limit 1 for update;
      if found then
        if ex.import_batch_id = p_batch_id and ex.register_updated_at is not null and ex.register_row is distinct from rn then
          issues := issues || jsonb_build_object('row', rn, 'plate', pl, 'level', 'error', 'field', 'plate',
                                                 'message', format('Plate appears twice in this file (first at row %s); this row was skipped', coalesce(ex.register_row::text, '?')));
          c_err := c_err + 1; continue;
        end if;
        if ex.on_platform and ex.service_type <> svc then
          issues := issues || jsonb_build_object('row', rn, 'plate', pl, 'level', 'warning', 'field', 'tanker_type',
                                                 'message', format('Register says %s, the tanker on the platform is %s; the platform''s type is kept', svc, ex.service_type));
          bad := true;
        end if;
        update public.tankers
           set in_register = true, governorate_code = gov, registry_owner_id = coalesce(oid, registry_owner_id),
               service_type = case when on_platform then service_type else svc end,
               register_permit_status = pst, register_permit_no = pno, register_row = rn, import_batch_id = p_batch_id, register_updated_at = now()
         where id = ex.id returning * into tk;
        c_tk_upd := c_tk_upd + 1;
      else
        insert into public.tankers (plate, service_type, capacity_gal, capacity_known, on_platform, in_register, governorate_code, registry_owner_id,
                                    register_permit_status, register_permit_no, register_row, import_batch_id, register_updated_at)
        values (pl, svc, 5000, false, false, true, gov, oid, pst, pno, rn, p_batch_id, now())
        returning * into tk;
        c_tk_new := c_tk_new + 1;
      end if;

      -- Permit records from the register's permit status.
      if pst = 'valid' then
        if pno is null or d_iss is null or d_exp is null or d_exp <= d_iss then
          issues := issues || jsonb_build_object('row', rn, 'plate', pl, 'level', 'warning', 'field', 'permit',
                                                 'message', 'Valid permit without a permit number and valid issue/expiry dates; no permit record created');
          bad := true;
        else
          select * into ep from public.permits where permit_no = pno;
          if found and ep.tanker_id <> tk.id then
            issues := issues || jsonb_build_object('row', rn, 'plate', pl, 'level', 'warning', 'field', 'permit_no', 'message', 'Permit number ' || pno || ' already belongs to another tanker; not imported');
            bad := true;
          elsif found then
            c_perm_have := c_perm_have + 1;
          else
            insert into public.permits (tanker_id, permit_no, type, issued_at, expires_at, status, stage, reviewed_by, reviewed_at, created_by)
            values (tk.id, pno, tk.service_type, d_iss::timestamp at time zone 'Asia/Muscat', (d_exp + 1)::timestamp at time zone 'Asia/Muscat' - interval '1 second',
                    'approved', 'decision', auth.uid(), now(), auth.uid());
            c_perm := c_perm + 1;
            if d_exp < (now() at time zone 'Asia/Muscat')::date then
              issues := issues || jsonb_build_object('row', rn, 'plate', pl, 'level', 'warning', 'field', 'permit_expiry', 'message', 'Permit already expired on ' || d_exp::text);
              bad := true;
            end if;
          end if;
        end if;
      elsif pst = 'in_progress' then
        if exists (select 1 from public.permits where tanker_id = tk.id and status = 'pending') then
          c_perm_have := c_perm_have + 1;
        else
          app_no := coalesce(pno, 'REG-' || regexp_replace(tk.plate, '[^A-Z0-9]', '', 'g'));
          if exists (select 1 from public.permits where permit_no = app_no) then
            app_no := app_no || '-' || upper(left(replace(p_batch_id::text, '-', ''), 6));
          end if;
          insert into public.permits (tanker_id, permit_no, type, issued_at, expires_at, status, stage, created_by)
          values (tk.id, app_no, tk.service_type, now(), now() + interval '12 months', 'pending', 'submitted', auth.uid())
          on conflict (permit_no) do nothing;
          if found then c_app := c_app + 1; end if;
        end if;
      elsif pno is not null or d_iss is not null or d_exp is not null then
        issues := issues || jsonb_build_object('row', rn, 'plate', pl, 'level', 'warning', 'field', 'permit_status',
                                               'message', 'Permit number or dates given but the status is No Permit; no permit record created (number kept on the tanker)');
        bad := true;
      end if;
      if bad then c_warn := c_warn + 1; end if;
    exception when others then
      issues := issues || jsonb_build_object('row', rn, 'plate', pl, 'level', 'error', 'field', 'row', 'message', left('Not imported: ' || sqlerrm, 200));
      c_err := c_err + 1;
    end;
  end loop;

  v_counts := jsonb_build_object('rows', c_rows, 'errors', c_err, 'warnings', c_warn, 'tankers_created', c_tk_new, 'tankers_updated', c_tk_upd,
                               'owners_created', c_own_new, 'owners_matched', c_own_match, 'no_owner', c_no_owner, 'no_phone', c_no_phone,
                               'permits_created', c_perm, 'applications_created', c_app, 'permits_existing', c_perm_have);
  update public.import_batches
     set counts = (select coalesce(jsonb_object_agg(k, coalesce((b.counts ->> k)::integer, 0) + coalesce((v_counts ->> k)::integer, 0)), '{}'::jsonb)
                     from jsonb_object_keys(v_counts) as k),
         errors = case when jsonb_array_length(errors) < 30000 then errors || issues else errors end,
         chunks = chunks + 1
   where id = b.id;
  perform public.write_audit('register.import_chunk', 'import_batch', b.id::text, null, jsonb_build_object('chunk', b.chunks + 1) || v_counts, null);
  return jsonb_build_object('counts', v_counts, 'issues', issues);
end $$;

-- Close the batch: adds the browser's validation issues (rows it never sent) to the report.
create function public.staff_import_batch_finish(p_batch_id uuid, p_client_issues jsonb default '[]'::jsonb, p_status text default 'completed')
returns public.import_batches
language plpgsql security definer set search_path = public
as $$
declare b public.import_batches; a public.import_batches; extra jsonb;
begin
  perform public.require_staff(array['permit_officer']::public.staff_role[]);
  if p_status not in ('completed', 'failed', 'cancelled') then raise exception 'invalid_state'; end if;
  select * into b from public.import_batches where id = p_batch_id for update;
  if not found then raise exception 'not_found'; end if;
  if b.status <> 'running' then raise exception 'invalid_state: the import is %', b.status; end if;
  extra := case when jsonb_typeof(p_client_issues) = 'array' then p_client_issues else '[]'::jsonb end;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into extra from (select x from jsonb_array_elements(extra) x limit 30000) s;
  update public.import_batches set status = p_status, finished_at = now(), errors = extra || errors where id = b.id returning * into a;
  perform public.write_audit('register.import', 'import_batch', b.id::text, null,
                             jsonb_build_object('file', a.file_name, 'status', a.status, 'rows', a.total_rows, 'chunks', a.chunks, 'counts', a.counts,
                                                'issues', jsonb_array_length(a.errors)), null);
  return a;
end $$;

-- ===========================================================================
-- Claiming: a registry owner signs up with the same verified mobile number
-- ===========================================================================
-- Verified mobile number of a user (E.164), or null.
create function public.verified_phone(p_user uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select public.normalize_phone(public.auth_phone_e164(u.phone)) from auth.users u
   where u.id = p_user and u.phone_confirmed_at is not null and nullif(u.phone, '') is not null
$$;

-- Links the user's registry owner rows (by verified number); an owner account with a company
-- takes over those owners' register tankers. Returns how many tankers joined the platform.
create function public.registry_claim(p_user uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare ph text; pr public.profiles; n integer := 0;
begin
  if p_user is null then return 0; end if;
  select * into pr from public.profiles where id = p_user;
  if not found then return 0; end if;
  ph := public.verified_phone(p_user);
  if ph is not null then
    update public.registry_owners set profile_id = p_user, claimed_at = coalesce(claimed_at, now()), updated_at = now()
     where phone = ph and profile_id is null;
  end if;
  if pr.role = 'owner' and pr.company_id is not null then
    update public.registry_owners set company_id = pr.company_id, updated_at = now() where profile_id = p_user and company_id is null;
    with moved as (
      update public.tankers t set company_id = pr.company_id, on_platform = true
       where t.registry_owner_id in (select id from public.registry_owners where profile_id = p_user)
         and t.company_id is null and not t.on_platform
         and not exists (select 1 from public.tanker_assignments a where a.tanker_id = t.id and a.unassigned_at is null)
      returning 1)
    select count(*)::int into n from moved;
  end if;
  return n;
end $$;

create function public.profiles_registry_claim()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.phone is distinct from old.phone or new.company_id is distinct from old.company_id then
    perform public.registry_claim(new.id);
  end if;
  return new;
end $$;
create trigger profiles_registry_claim after insert or update of phone, company_id on public.profiles
  for each row execute function public.profiles_registry_claim();

-- The signed-in user's register entries: {owners, tankers, joined}. Also claims (idempotent).
create function public.my_registry_claim()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare joined integer;
begin
  if auth.uid() is null then raise exception 'not_found'; end if;
  joined := public.registry_claim(auth.uid());
  return jsonb_build_object(
    'joined', joined,
    'owners', (select count(*) from public.registry_owners where profile_id = auth.uid()),
    'tankers', coalesce((select jsonb_agg(jsonb_build_object('plate', t.plate, 'service_type', t.service_type, 'on_platform', t.on_platform) order by t.plate)
                           from public.tankers t join public.registry_owners o on o.id = t.registry_owner_id where o.profile_id = auth.uid()), '[]'::jsonb));
end $$;

-- May the signed-in user adopt this register tanker? Yes when the register names no owner or no
-- number for it, or the number is the user's verified one (or the owner row is already theirs).
create function public.registry_can_adopt(p_owner uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_owner is null or exists (
    select 1 from public.registry_owners o
     where o.id = p_owner and (o.phone is null or o.profile_id = auth.uid() or o.phone = public.verified_phone(auth.uid())))
$$;

-- Drivers: a plate that is only in the register is adopted (with the capacity the driver gives).
create or replace function public.driver_register_tanker(p_plate text, p_service_type public.service_type, p_capacity_gal integer)
returns public.tankers
language plpgsql security definer set search_path = public
as $$
declare t public.tankers; ex public.tankers; pl text := coalesce(public.normalize_plate(p_plate), upper(btrim(p_plate)));
begin
  if public.my_role() is distinct from 'driver' then raise exception 'not_a_driver'; end if;
  if public.my_tanker_id() is not null then raise exception 'already_assigned'; end if;
  select * into ex from public.tankers where public.normalize_plate(plate) = public.normalize_plate(pl) or plate = pl order by on_platform desc limit 1 for update;
  if found then
    if ex.on_platform or ex.company_id is not null
       or exists (select 1 from public.tanker_assignments a where a.tanker_id = ex.id and a.unassigned_at is null) then raise exception 'plate_taken'; end if;
    if not public.registry_can_adopt(ex.registry_owner_id) then raise exception 'plate_in_register'; end if;
    update public.tankers
       set on_platform = true, capacity_gal = p_capacity_gal, capacity_known = true,
           service_type = case when exists (select 1 from public.permits p where p.tanker_id = ex.id) then service_type else p_service_type end
     where id = ex.id returning * into t;
    update public.registry_owners set profile_id = auth.uid(), claimed_at = coalesce(claimed_at, now()), updated_at = now()
     where id = ex.registry_owner_id and profile_id is null and phone = public.verified_phone(auth.uid());
  else
    begin
      insert into public.tankers (plate, service_type, capacity_gal) values (pl, p_service_type, p_capacity_gal) returning * into t;
    exception when unique_violation then
      raise exception 'plate_taken';
    end;
  end if;
  insert into public.tanker_assignments (driver_id, tanker_id, assigned_by) values (auth.uid(), t.id, auth.uid());
  return t;
end $$;

-- Owners: the same, the tanker joining the owner's company.
create or replace function public.owner_register_tanker(p_plate text, p_service_type public.service_type, p_capacity_gal integer)
returns public.tankers
language plpgsql security definer set search_path = public
as $$
declare t public.tankers; ex public.tankers; dev text; pl text := coalesce(public.normalize_plate(p_plate), upper(btrim(p_plate)));
begin
  if not public.is_owner() then raise exception 'not_an_owner'; end if;
  select * into ex from public.tankers where public.normalize_plate(plate) = public.normalize_plate(pl) or plate = pl order by on_platform desc limit 1 for update;
  if found then
    if ex.on_platform or ex.company_id is not null
       or exists (select 1 from public.tanker_assignments a where a.tanker_id = ex.id and a.unassigned_at is null) then raise exception 'plate_taken'; end if;
    if not public.registry_can_adopt(ex.registry_owner_id) then raise exception 'plate_in_register'; end if;
    update public.tankers
       set on_platform = true, company_id = public.my_company_id(), capacity_gal = p_capacity_gal, capacity_known = true,
           service_type = case when exists (select 1 from public.permits p where p.tanker_id = ex.id) then service_type else p_service_type end
     where id = ex.id returning * into t;
    update public.registry_owners set profile_id = auth.uid(), company_id = coalesce(company_id, public.my_company_id()), claimed_at = coalesce(claimed_at, now()), updated_at = now()
     where id = ex.registry_owner_id and profile_id is null and phone = public.verified_phone(auth.uid());
  else
    begin
      insert into public.tankers (plate, service_type, capacity_gal, company_id)
      values (pl, p_service_type, p_capacity_gal, public.my_company_id()) returning * into t;
    exception when unique_violation then raise exception 'plate_taken';
    end;
  end if;
  -- Simulated IVMS provisioning: every registered tanker gets a device.
  dev := 'IV-' || (70000 + (select count(*) from public.devices) + 1);
  insert into public.devices (id, tanker_id) values (dev, t.id) on conflict (id) do nothing;
  return t;
end $$;

-- ===========================================================================
-- Access: staff read; writes only through the RPCs above
-- ===========================================================================
alter table public.import_batches enable row level security;
alter table public.registry_owners enable row level security;
revoke all on public.import_batches, public.registry_owners from anon, authenticated;
grant select on public.import_batches to authenticated;
-- Phone numbers aren't selectable directly: screens get them masked from staff_register_tankers (0033).
grant select (id, name, governorate_code, profile_id, company_id, claimed_at, invited_at, invite_count, sms_opt_out, opted_out_at,
              first_batch_id, batch_id, created_at, updated_at) on public.registry_owners to authenticated;
create policy import_batches_staff on public.import_batches for select to authenticated
  using (public.my_staff_role() in ('admin', 'permit_officer', 'operator', 'inspector', 'viewer'));
create policy registry_owners_staff on public.registry_owners for select to authenticated using (public.is_staff());

revoke execute on function public.registry_claim(uuid), public.profiles_registry_claim(), public.verified_phone(uuid), public.registry_can_adopt(uuid)
  from public, anon, authenticated;
revoke execute on function public.register_service_type(text), public.register_permit_status(text), public.register_date(text) from public, anon;
grant execute on function public.register_service_type(text), public.register_permit_status(text), public.register_date(text) to authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'staff_import_batch_start(text, integer, jsonb, text)', 'staff_import_register(jsonb, uuid)', 'staff_import_batch_finish(uuid, jsonb, text)',
    'my_registry_claim()', 'driver_register_tanker(text, public.service_type, integer)', 'owner_register_tanker(text, public.service_type, integer)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
