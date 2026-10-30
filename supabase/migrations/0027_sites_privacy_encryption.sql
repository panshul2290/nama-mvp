-- Tender gaps, batch A (part 2 of 4):
--   F9   per-site business access: an organisation admin can limit a member to some
--        sites (properties). A member with no sites listed keeps organisation-wide
--        access (admins and finance by default). Enforced in RLS (orders, their
--        locations, evidence and payments, sites, contracts, penalties, invoices,
--        complaints) and in the business RPCs.
--   F11  privacy: the PRIVACY settings are applied. ID numbers are masked everywhere
--        and revealed only to privileged roles through an audited RPC; staff screens
--        mask phone numbers for other roles (full number through an audited reveal);
--        exact addresses stay hidden until a driver accepts (RLS, always on); new
--        accounts get the usage-data default; a daily retention job purges GPS fixes,
--        chats and delivery photos of closed orders older than the set periods and
--        anonymises old delivery addresses (never an open order); reminders and
--        marketing check consent (0026 notify); data-subject requests are processed:
--        access → an export the customer can download, delete → anonymisation.
--   H4   field encryption: national ID numbers and company IBANs are encrypted at
--        rest with pgcrypto (AES-256, PGP symmetric) under a key held in Supabase
--        Vault (a private-schema table where Vault doesn't exist, e.g. PGlite).
--        The plain columns keep only a masked value ("•••• 1234"), written by a
--        trigger, so every existing reader shows the mask; decryption happens only
--        inside security-definer RPCs for allowed roles. docs/security/field-encryption.md.

-- ===========================================================================
-- H4 — key and helpers
-- ===========================================================================
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Fallback key store for databases without Supabase Vault (local / PGlite). Production
-- uses Vault (see the docs); this table is then empty.
create table private.field_keys (
  name       text primary key,
  key        text not null,
  created_at timestamptz not null default now()
);
revoke all on private.field_keys from public, anon, authenticated;

do $$
begin
  if to_regclass('vault.decrypted_secrets') is not null then
    if not exists (select 1 from vault.decrypted_secrets where name = 'nama_field_key') then
      perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'nama_field_key', 'Nama: field encryption key (national ID numbers, IBANs)');
    end if;
  else
    insert into private.field_keys (name, key) values ('nama_field_key', encode(extensions.gen_random_bytes(32), 'hex')) on conflict do nothing;
  end if;
end $$;

create function private.field_key()
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare k text;
begin
  if to_regclass('vault.decrypted_secrets') is not null then
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into k using 'nama_field_key';
  end if;
  if k is null then select f.key into k from private.field_keys f where f.name = 'nama_field_key'; end if;
  if k is null then raise exception 'field_key_missing'; end if;
  return k;
end $$;
revoke execute on function private.field_key() from public, anon, authenticated;

create function public.pii_encrypt(p text)
returns bytea language sql volatile security definer set search_path = ''
as $$ select case when p is null then null else extensions.pgp_sym_encrypt(p, private.field_key(), 'cipher-algo=aes256') end $$;

create function public.pii_decrypt(p bytea)
returns text language sql stable security definer set search_path = ''
as $$ select case when p is null then null else extensions.pgp_sym_decrypt(p, private.field_key()) end $$;

create function public.mask_tail(p text)
returns text language sql immutable
as $$ select case when nullif(btrim(coalesce(p, '')), '') is null then null else '•••• ' || right(regexp_replace(p, '\s', '', 'g'), 4) end $$;

revoke execute on function public.pii_encrypt(text), public.pii_decrypt(bytea) from public, anon, authenticated;

-- ===========================================================================
-- H4 — ID numbers and IBANs: ciphertext column + masked plain column
-- ===========================================================================
alter table public.profiles add column id_no_enc bytea;
alter table public.companies add column iban_enc bytea;

-- Whoever writes id_no (verify_identity, seeds, staff tools) writes a plain number; the
-- trigger encrypts it and leaves only the mask. A mask written back is ignored.
create function public.profiles_encrypt_id()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.id_no is not null and new.id_no not like '••••%' then
    new.id_no_enc := public.pii_encrypt(btrim(new.id_no));
    new.id_no := public.mask_tail(new.id_no);
  elsif new.id_no is null then
    new.id_no_enc := null;
  end if;
  return new;
end $$;
create trigger profiles_encrypt_id before insert or update of id_no on public.profiles
  for each row execute function public.profiles_encrypt_id();

create function public.companies_encrypt_iban()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.iban is not null and new.iban not like '••••%' then
    new.iban_enc := public.pii_encrypt(upper(replace(btrim(new.iban), ' ', '')));
    new.iban := public.mask_tail(new.iban);
  elsif new.iban is null then
    new.iban_enc := null;
  end if;
  return new;
end $$;
create trigger companies_encrypt_iban before insert or update of iban on public.companies
  for each row execute function public.companies_encrypt_iban();

revoke execute on function public.profiles_encrypt_id(), public.companies_encrypt_iban() from public, anon, authenticated;

-- Migrate what's there.
update public.profiles set id_no = id_no where id_no is not null and id_no not like '••••%';
update public.companies set iban = iban where iban is not null and iban not like '••••%';

-- ===========================================================================
-- F11 — privacy settings, applied
-- ===========================================================================
update public.app_settings
   set value = ((value::jsonb - 'residency')
                || jsonb_build_object('mask_id', true, 'retention_chat_days', 180, 'retention_photo_days', 365,
                                      'privileged_roles', jsonb_build_array('admin', 'complaints_agent'),
                                      'hosting', 'Supabase (Tokyo) for the pilot; to be moved to Oman at go-live')
                || (value::jsonb - 'residency'))::text,
       notes = 'Data privacy controls, applied by the database: masking, retention (daily job), usage-data default for new accounts, privileged roles for reveals.'
 where key = 'PRIVACY';

-- Is the caller a role that may see full phone numbers and ID numbers (audited reveals)?
create function public.staff_privileged()
returns boolean language sql stable security definer set search_path = public
as $$
  select public.my_staff_role() is not null
     and coalesce(public.setting_json('PRIVACY') -> 'privileged_roles', '["admin"]'::jsonb) ? public.my_staff_role()::text
$$;

-- Staff: identity and consent fields (CRM, privacy report). ID numbers come masked;
-- reveal one with staff_reveal_identity.
create or replace function public.staff_private_profiles(p_ids uuid[] default null)
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

create function public.staff_reveal_identity(p_profile uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare p public.profiles; r text;
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  if not public.staff_privileged() then raise exception 'forbidden_for_role: only privileged roles (Settings → Data privacy) can reveal ID numbers'; end if;
  r := public.require_reason(p_reason);
  select * into p from public.profiles where id = p_profile;
  if not found then raise exception 'not_found'; end if;
  perform public.write_audit('privacy.reveal_id', 'profile', p.id::text, null, jsonb_build_object('id_type', p.id_type), r);
  return jsonb_build_object('id_type', p.id_type, 'id_no', public.pii_decrypt(p.id_no_enc));
end $$;

-- Full phone and email of one person (for a call-back), audited. Non-privileged roles
-- see masked numbers on NWS screens.
create function public.staff_reveal_contact(p_profile uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare p public.profiles; r text;
begin
  if not public.is_staff() then raise exception 'not_staff'; end if;
  if not public.staff_privileged() then raise exception 'forbidden_for_role: only privileged roles (Settings → Data privacy) can reveal contact details'; end if;
  r := public.require_reason(p_reason);
  select * into p from public.profiles where id = p_profile;
  if not found then raise exception 'not_found'; end if;
  perform public.write_audit('privacy.reveal_contact', 'profile', p.id::text, null, null, r);
  return jsonb_build_object('phone', p.phone, 'email', p.email);
end $$;

-- Finance: a company's IBAN for a payout, audited.
create function public.staff_reveal_bank(p_company uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare c public.companies; r text;
begin
  perform public.require_staff(array['finance']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into c from public.companies where id = p_company;
  if not found then raise exception 'not_found'; end if;
  perform public.write_audit('privacy.reveal_bank', 'company', c.id::text, null, null, r);
  return jsonb_build_object('bank_name', c.bank_name, 'iban', public.pii_decrypt(c.iban_enc));
end $$;

-- Usage-data default for new accounts (they can change it in their app).
create function public.profiles_default_prefs()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if not (coalesce(new.prefs, '{}'::jsonb) ? 'share_usage') then
    new.prefs := coalesce(new.prefs, '{}'::jsonb)
                 || jsonb_build_object('share_usage', coalesce((public.setting_json('PRIVACY') ->> 'usage_data_default')::boolean, false));
  end if;
  return new;
end $$;
create trigger profiles_default_prefs before insert on public.profiles for each row execute function public.profiles_default_prefs();
revoke execute on function public.profiles_default_prefs() from public, anon, authenticated;

-- Settings: validated, including the new privacy keys.
create or replace function public.staff_update_setting(p_key text, p_value jsonb, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare b jsonb; r text; c text; k text;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  if p_key not in ('PRIVACY', 'LOYALTY', 'NOTIFY', 'DISPATCH', 'FILL_CREDIT', 'SLA') then raise exception 'invalid_setting'; end if;
  if p_key = 'LOYALTY' and not (coalesce((p_value ->> 'points_per_omr')::numeric, 0) > 0 and coalesce((p_value ->> 'redeem_points')::numeric, 0) >= 1
                                and coalesce((p_value ->> 'redeem_omr')::numeric, 0) > 0) then
    raise exception 'invalid_value';
  end if;
  if p_key = 'PRIVACY' then
    foreach k in array array['mask_phone', 'mask_id', 'mask_address', 'usage_data_default'] loop
      if jsonb_typeof(p_value -> k) <> 'boolean' then raise exception 'invalid_value: % must be true or false', k; end if;
    end loop;
    if coalesce((p_value ->> 'retention_gps_days')::integer, 0) not between 7 and 3650
       or coalesce((p_value ->> 'retention_chat_days')::integer, 0) not between 30 and 3650
       or coalesce((p_value ->> 'retention_photo_days')::integer, 0) not between 30 and 3650
       or coalesce((p_value ->> 'retention_orders_years')::integer, 0) not between 1 and 15 then
      raise exception 'invalid_value: retention periods out of range';
    end if;
    if jsonb_typeof(p_value -> 'privileged_roles') <> 'array' or not (p_value -> 'privileged_roles') ? 'admin'
       or exists (select 1 from jsonb_array_elements_text(p_value -> 'privileged_roles') x
                   where x not in ('admin', 'operator', 'permit_officer', 'inspector', 'complaints_agent', 'finance')) then
      raise exception 'invalid_value: privileged roles must include admin and be staff roles (viewers never)';
    end if;
    p_value := p_value - 'residency';
  end if;
  if p_key = 'NOTIFY' then
    if jsonb_typeof(p_value -> 'providers') <> 'object' or coalesce((p_value ->> 'max_attempts')::integer, 0) not between 1 and 10 then raise exception 'invalid_value'; end if;
    foreach c in array array['push', 'sms', 'whatsapp', 'email'] loop
      if coalesce(p_value -> 'providers' ->> c, '') not in ('simulated', 'external', 'off') then raise exception 'invalid_value: provider for % must be simulated, external or off', c; end if;
    end loop;
  end if;
  if p_key = 'DISPATCH' and not (coalesce((p_value ->> 'speed_kmh')::numeric, 0) between 5 and 120 and coalesce((p_value ->> 'max_km')::numeric, 0) between 1 and 500
                                 and coalesce((p_value ->> 'weight_jobs')::numeric, -1) between 0 and 120 and coalesce((p_value ->> 'weight_rating')::numeric, -1) between 0 and 120
                                 and coalesce((p_value ->> 'max_offers')::integer, 0) between 1 and 20) then
    raise exception 'invalid_value';
  end if;
  if p_key = 'FILL_CREDIT' and not (jsonb_typeof(p_value -> 'block_when_insufficient') = 'boolean' and coalesce((p_value ->> 'low_balance_omr')::numeric, -1) >= 0
                                    and coalesce((p_value ->> 'min_topup_omr')::numeric, 0) >= 1
                                    and coalesce((p_value ->> 'max_topup_omr')::numeric, 0) >= coalesce((p_value ->> 'min_topup_omr')::numeric, 0)) then
    raise exception 'invalid_value';
  end if;
  if p_key = 'SLA' and not (coalesce((p_value ->> 'asap_minutes')::integer, 0) between 15 and 1440 and coalesce((p_value ->> 'target_pct')::numeric, 0) between 0.5 and 1) then
    raise exception 'invalid_value';
  end if;
  b := public.setting_json(p_key);
  update public.app_settings set value = p_value::text where key = p_key;
  perform public.write_audit('setting.update', 'setting', p_key, b, p_value, r);
  return p_value;
end $$;

-- ===========================================================================
-- F11 — retention (daily). Only closed orders' data; open orders are never touched.
-- ===========================================================================
alter table public.pods add column media_purged_at timestamptz;
alter table public.complaints add column photo_purged_at timestamptz;

-- Storage paths whose database references were removed; the files are deleted by the
-- Storage API (SQL can't remove the underlying objects), see docs/security.
create table public.storage_purge_queue (
  path      text primary key,
  reason    text not null,
  queued_at timestamptz not null default now(),
  done_at   timestamptz
);

create table public.retention_runs (
  id         bigint generated always as identity primary key,
  ran_at     timestamptz not null default now(),
  ran_by     uuid references public.profiles (id) on delete set null,
  dry_run    boolean not null default false,
  result     jsonb not null
);

create function public.run_retention(p_dry boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  cfg jsonb := public.setting_json('PRIVACY');
  gps_cut timestamptz := now() - make_interval(days => coalesce((cfg ->> 'retention_gps_days')::integer, 90));
  chat_cut timestamptz := now() - make_interval(days => coalesce((cfg ->> 'retention_chat_days')::integer, 180));
  photo_cut timestamptz := now() - make_interval(days => coalesce((cfg ->> 'retention_photo_days')::integer, 365));
  addr_cut timestamptz := now() - make_interval(years => coalesce((cfg ->> 'retention_orders_years')::integer, 7));
  n_gps integer; n_chat integer; n_pod integer; n_cmp integer; n_addr integer; res jsonb;
begin
  -- GPS fixes: not on an order, or on a closed one.
  select count(*) into n_gps from public.gps_fixes g
   where g.recorded_at < gps_cut and (g.order_id is null or exists (select 1 from public.orders o where o.id = g.order_id and o.status in ('delivered', 'cancelled')));
  select count(*) into n_chat from public.order_messages m join public.orders o on o.id = m.order_id
   where m.created_at < chat_cut and o.status in ('delivered', 'cancelled');
  select count(*) into n_pod from public.pods d join public.orders o on o.id = d.order_id
   where d.created_at < photo_cut and o.status in ('delivered', 'cancelled') and d.media_purged_at is null
     and (d.photo_path is not null or d.signature_path is not null or d.signature_svg is not null);
  select count(*) into n_cmp from public.complaints c
   where c.created_at < photo_cut and c.state = 'resolved' and c.photo_path is not null;
  select count(*) into n_addr from public.order_locations l join public.orders o on o.id = l.order_id
   where coalesce(o.delivered_at, o.cancelled_at, o.created_at) < addr_cut and o.status in ('delivered', 'cancelled') and l.address <> '';
  res := jsonb_build_object('gps_fixes', n_gps, 'chat_messages', n_chat, 'delivery_media', n_pod, 'complaint_photos', n_cmp, 'addresses', n_addr,
                            'cutoffs', jsonb_build_object('gps', gps_cut, 'chat', chat_cut, 'photos', photo_cut, 'addresses', addr_cut));
  if p_dry then return res; end if;

  delete from public.gps_fixes g
   where g.recorded_at < gps_cut and (g.order_id is null or exists (select 1 from public.orders o where o.id = g.order_id and o.status in ('delivered', 'cancelled')));
  delete from public.order_messages m using public.orders o
   where o.id = m.order_id and m.created_at < chat_cut and o.status in ('delivered', 'cancelled');
  insert into public.storage_purge_queue (path, reason)
  select x.p, 'retention' from (
    select d.photo_path as p from public.pods d join public.orders o on o.id = d.order_id
     where d.created_at < photo_cut and o.status in ('delivered', 'cancelled') and d.media_purged_at is null
    union select d.signature_path from public.pods d join public.orders o on o.id = d.order_id
     where d.created_at < photo_cut and o.status in ('delivered', 'cancelled') and d.media_purged_at is null
    union select c.photo_path from public.complaints c where c.created_at < photo_cut and c.state = 'resolved') x
   where x.p is not null
  on conflict (path) do nothing;
  update public.pods d set photo_path = null, signature_path = null, signature_svg = null, media_purged_at = now()
    from public.orders o
   where o.id = d.order_id and d.created_at < photo_cut and o.status in ('delivered', 'cancelled') and d.media_purged_at is null
     and (d.photo_path is not null or d.signature_path is not null or d.signature_svg is not null);
  update public.complaints set photo_path = null, photo_purged_at = now()
   where created_at < photo_cut and state = 'resolved' and photo_path is not null;
  -- Old delivery addresses: kept to about 1 km (for statistics), the street address removed.
  update public.order_locations l set address = '', lat = round(l.lat::numeric, 2)::double precision, lng = round(l.lng::numeric, 2)::double precision
    from public.orders o
   where o.id = l.order_id and coalesce(o.delivered_at, o.cancelled_at, o.created_at) < addr_cut and o.status in ('delivered', 'cancelled') and l.address <> '';
  insert into public.retention_runs (ran_by, dry_run, result) values (auth.uid(), false, res);
  return res;
end $$;

create function public.staff_run_retention(p_dry boolean default true)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare res jsonb;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  res := public.run_retention(coalesce(p_dry, true));
  if not coalesce(p_dry, true) then
    perform public.write_audit('privacy.retention', 'setting', 'PRIVACY', null, res, 'Retention run from Settings → Data privacy');
  end if;
  return res;
end $$;

-- ===========================================================================
-- F11 — data-subject requests: access (export) and delete (anonymise)
-- ===========================================================================
alter table public.data_requests add column result_note text;

create table public.data_exports (
  request_id  uuid primary key references public.data_requests (id) on delete cascade,
  customer_id uuid not null references public.profiles (id) on delete cascade,
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 days'
);

-- Everything held about one customer, in one document (the ID number decrypted: it is theirs).
create function public.customer_export(p_customer uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'generated_at', now(),
    'profile', (select jsonb_build_object('id', p.id, 'full_name', p.full_name, 'phone', p.phone, 'email', p.email, 'language', p.lang,
                                          'segment', p.segment, 'id_type', p.id_type, 'id_no', public.pii_decrypt(p.id_no_enc), 'id_verified', p.id_verified,
                                          'preferences', p.prefs, 'loyalty_points', p.loyalty_points, 'created_at', p.created_at)
                  from public.profiles p where p.id = p_customer),
    'properties', coalesce((select jsonb_agg(jsonb_build_object('label', x.label, 'address', x.address, 'area', x.area, 'lat', x.lat, 'lng', x.lng, 'tank_gal', x.tank_gal))
                              from public.properties x where x.customer_id = p_customer), '[]'),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('order', 'TO-' || o.order_no, 'service', o.service_type, 'gallons', o.gallons, 'status', o.status,
                                                             'total_omr', o.total, 'created_at', o.created_at, 'delivered_at', o.delivered_at,
                                                             'address', l.address, 'lat', l.lat, 'lng', l.lng, 'rating', o.rating, 'comment', o.rating_comment) order by o.created_at)
                          from public.orders o left join public.order_locations l on l.order_id = o.id where o.customer_id = p_customer), '[]'),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('method', y.method, 'amount', y.amount, 'status', y.status, 'card_last4', y.card_last4, 'at', y.created_at) order by y.created_at)
                            from public.payments y where y.customer_id = p_customer), '[]'),
    'wallet', coalesce((select jsonb_agg(jsonb_build_object('kind', w.kind, 'amount', w.amount, 'memo', w.memo, 'at', w.created_at) order by w.id)
                          from public.wallet_tx w where w.customer_id = p_customer), '[]'),
    'complaints', coalesce((select jsonb_agg(jsonb_build_object('case', c.case_no, 'category', c.category, 'description', c.description, 'state', c.state, 'at', c.created_at))
                              from public.complaints c where c.customer_id = p_customer), '[]'),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('order_id', m.order_id, 'body', m.body, 'at', m.created_at) order by m.id)
                            from public.order_messages m where m.sender_id = p_customer), '[]'),
    'notifications', coalesce((select jsonb_agg(jsonb_build_object('event', n.event, 'title', n.title, 'body', n.body, 'channels', n.channels, 'at', n.created_at) order by n.id)
                                 from public.notifications n where n.user_id = p_customer), '[]'),
    'data_requests', coalesce((select jsonb_agg(jsonb_build_object('ref', d.ref_no, 'kind', d.kind, 'state', d.state, 'at', d.created_at))
                                 from public.data_requests d where d.customer_id = p_customer), '[]'))
$$;

-- Erase a customer's personal data, keeping the financial and service records the
-- retention rules require (orders, payments, invoices) under an anonymous profile.
create function public.anonymise_customer(p_customer uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.profiles
     set full_name = 'Deleted customer', phone = null, email = null, id_type = null, id_no = null, id_verified = false,
         prefs = '{}'::jsonb, account_blocked = true, loyalty_points = 0
   where id = p_customer;
  delete from public.push_tokens where user_id = p_customer;
  delete from public.payment_methods where customer_id = p_customer;
  delete from public.notification_outbox where user_id = p_customer;
  delete from public.notifications where user_id = p_customer;
  update public.order_messages set body = '[removed at the customer''s request]' where sender_id = p_customer;
  update public.complaints set description = '[removed at the customer''s request]', photo_path = null where customer_id = p_customer;
  update public.order_locations l set address = '', lat = round(l.lat::numeric, 2)::double precision, lng = round(l.lng::numeric, 2)::double precision
    from public.orders o where o.id = l.order_id and o.customer_id = p_customer;
  delete from public.properties x where x.customer_id = p_customer and not exists (select 1 from public.contracts k where k.property_id = x.id);
  update public.properties set label = 'Removed', address = '', lat = round(lat::numeric, 2)::double precision, lng = round(lng::numeric, 2)::double precision
   where customer_id = p_customer;
  update auth.users set email = null, phone = null, raw_user_meta_data = '{}'::jsonb where id = p_customer;
  -- Sign-in ends everywhere (Supabase Auth tables, when present).
  begin
    execute 'delete from auth.sessions where user_id = $1' using p_customer;
  exception when undefined_table then null;
  end;
end $$;

create function public.staff_process_data_request(p_request_id uuid, p_reason text)
returns public.data_requests
language plpgsql security definer set search_path = public
as $$
declare d public.data_requests; a public.data_requests; r text; note text;
begin
  perform public.require_staff(array['admin']::public.staff_role[]);
  r := public.require_reason(p_reason);
  select * into d from public.data_requests where id = p_request_id for update;
  if not found or d.customer_id is null then raise exception 'not_found'; end if;
  if d.state <> 'open' then raise exception 'invalid_state: request already closed'; end if;
  if d.kind = 'access' then
    insert into public.data_exports (request_id, customer_id, payload) values (d.id, d.customer_id, public.customer_export(d.customer_id))
    on conflict (request_id) do update set payload = excluded.payload, created_at = now(), expires_at = now() + interval '30 days';
    perform public.notify(d.customer_id, 'data_export_ready', null, jsonb_build_object('request', 'DR-' || d.ref_no));
    note := 'Export prepared; available to the customer for 30 days';
  elsif d.kind = 'delete' then
    if exists (select 1 from public.orders where customer_id = d.customer_id
                 and status in ('scheduled', 'pending_approval', 'requested', 'accepted', 'arriving', 'arrived', 'collected')) then
      raise exception 'has_open_orders: finish or cancel the customer''s open orders first';
    end if;
    if public.wallet_balance(d.customer_id) <> 0 then
      raise exception 'wallet_not_empty: settle the wallet balance (% OMR) first', to_char(public.wallet_balance(d.customer_id), 'FM99990.000');
    end if;
    if exists (select 1 from public.contracts where customer_id = d.customer_id and status in ('pending_owner', 'active', 'paused')) then
      raise exception 'has_contract: end the customer''s contracts first';
    end if;
    perform public.anonymise_customer(d.customer_id);
    note := 'Personal data erased; order and payment records kept anonymously under the retention rules';
  else
    raise exception 'manual_request: correct the record, then close the request';
  end if;
  update public.data_requests set state = 'completed', closed_at = now(), closed_by = auth.uid(), result_note = note where id = d.id returning * into a;
  perform public.write_audit('data_request.processed', 'data_request', d.id::text, jsonb_build_object('kind', d.kind, 'state', d.state),
                             jsonb_build_object('state', 'completed', 'note', note), r);
  return a;
end $$;

create function public.my_data_export(p_request_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$ select e.payload from public.data_exports e where e.request_id = p_request_id and e.customer_id = auth.uid() and e.expires_at > now() $$;

-- ===========================================================================
-- F9 — per-site access for business members
-- ===========================================================================
create table public.org_member_sites (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  property_id uuid not null references public.properties (id) on delete cascade,
  org_id      uuid not null references public.organizations (id) on delete cascade,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (user_id, property_id)
);
create index org_member_sites_org_idx on public.org_member_sites (org_id);

-- Is the caller limited to some sites?
create function public.my_sites_restricted()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.org_member_sites s where s.user_id = auth.uid() and s.org_id = public.my_org_id()) $$;

-- May the caller (a business member) see this organisation order / site?
create function public.org_order_visible(p_org uuid, p_property uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select p_org is not null and p_org = public.my_org_id()
     and (not public.my_sites_restricted()
          or (p_property is not null and exists (select 1 from public.org_member_sites s where s.user_id = auth.uid() and s.property_id = p_property)))
$$;

-- Admin: limit a member to some sites (empty = the whole organisation). An admin can't
-- restrict themselves (no lock-out).
create function public.org_set_member_sites(p_member uuid, p_property_ids uuid[])
returns integer
language plpgsql security definer set search_path = public
as $$
declare m public.profiles; org uuid := public.my_org_id(); n integer;
begin
  if coalesce(public.my_org_role(), '') <> 'admin' or public.my_sites_restricted() then raise exception 'forbidden_for_role'; end if;
  if p_member = auth.uid() then raise exception 'cannot_restrict_self'; end if;
  select * into m from public.profiles where id = p_member and org_id = org and role = 'business' for update;
  if not found then raise exception 'not_found'; end if;
  if exists (select 1 from unnest(coalesce(p_property_ids, '{}')) x where not exists (select 1 from public.properties p where p.id = x and p.org_id = org)) then
    raise exception 'not_found: a site is not in this organisation';
  end if;
  delete from public.org_member_sites where user_id = p_member;
  insert into public.org_member_sites (user_id, property_id, org_id, created_by)
  select p_member, x, org, auth.uid() from (select distinct unnest(coalesce(p_property_ids, '{}')) as x) s;
  get diagnostics n = row_count;
  return n;
end $$;

-- Org members see their organisation's site lists (admins manage them; members see their own).
create policy org_member_sites_read on public.org_member_sites for select to authenticated using (
  org_id = public.my_org_id() and (public.my_org_role() = 'admin' or user_id = auth.uid()));
create policy org_member_sites_staff on public.org_member_sites for select to authenticated using (public.is_staff());

-- RLS: the organisation parts of the policies now go through org_order_visible.
drop policy orders_org on public.orders;
create policy orders_org on public.orders for select to authenticated using (public.org_order_visible(org_id, property_id));
drop policy order_locations_org on public.order_locations;
create policy order_locations_org on public.order_locations for select to authenticated using (
  exists (select 1 from public.orders o where o.id = order_locations.order_id and public.org_order_visible(o.org_id, o.property_id)));
drop policy properties_own on public.properties;
create policy properties_own on public.properties for select to authenticated using (customer_id = auth.uid() or public.org_order_visible(org_id, id));
drop policy contracts_party on public.contracts;
create policy contracts_party on public.contracts for select to authenticated using (
  customer_id = auth.uid() or public.org_order_visible(org_id, property_id) or company_id = public.my_company_id());
drop policy payments_own on public.payments;
create policy payments_own on public.payments for select to authenticated using (
  customer_id = auth.uid()
  or (org_id is not null and exists (select 1 from public.orders o where o.id = payments.order_id and public.org_order_visible(o.org_id, o.property_id))));
drop policy penalties_customer on public.penalties;
create policy penalties_customer on public.penalties for select to authenticated using (
  customer_id = auth.uid() or (org_id is not null and org_id = public.my_org_id() and not public.my_sites_restricted()));
-- Invoices cover every site: members limited to some sites don't see them.
drop policy invoices_org on public.invoices;
create policy invoices_org on public.invoices for select to authenticated using (org_id = public.my_org_id() and not public.my_sites_restricted());
drop policy tankers_org_active on public.tankers;
create policy tankers_org_active on public.tankers for select to authenticated using (
  exists (select 1 from public.orders o where o.tanker_id = tankers.id and public.org_order_visible(o.org_id, o.property_id)
             and o.status in ('accepted', 'arriving', 'arrived', 'collected')));
drop policy complaints_org on public.complaints;
create policy complaints_org on public.complaints for select to authenticated using (
  public.my_org_role() = 'admin' and exists (select 1 from public.orders o where o.id = complaints.order_id and public.org_order_visible(o.org_id, o.property_id)));

create or replace function public.can_see_order(p_order uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.orders o
     where o.id = p_order
       and (o.customer_id = auth.uid()
            or o.driver_id = auth.uid()
            or public.org_order_visible(o.org_id, o.property_id)
            or public.in_my_company(o.tanker_id)))
$$;

-- Business RPCs: the same site check. Bulk orders also reserve credit at the price the
-- order will really have (distance and demand included, 0026).
create or replace function public.org_create_orders(p_property_id uuid, p_service_type public.service_type, p_gallons integer, p_count integer,
                                                    p_slot_start timestamptz default null, p_slot_end timestamptz default null, p_slot_label text default null,
                                                    p_po_number text default null, p_note text default null)
returns setof public.orders
language plpgsql security definer set search_path = public
as $$
declare
  org public.organizations; prop public.properties; o public.orders; q record; st public.order_status; i integer; z public.zones; f jsonb;
begin
  if coalesce(public.my_org_role(), '') not in ('admin', 'site_manager') then raise exception 'forbidden_for_role'; end if;
  select * into org from public.organizations where id = public.my_org_id() for update;
  if org.status <> 'active' then raise exception 'account_not_active'; end if;
  if org.paused then raise exception 'account_paused'; end if;
  select * into prop from public.properties where id = p_property_id and org_id = org.id;
  if not found or not public.org_order_visible(org.id, prop.id) then raise exception 'not_found'; end if;
  if p_count is null or p_count < 1 or p_count > 20 then raise exception 'invalid_count'; end if;
  if p_gallons is null or p_gallons < 100 or p_gallons > 20000 then raise exception 'invalid_gallons'; end if;
  if p_slot_start is not null and (p_slot_end is null or p_slot_end <= p_slot_start or p_slot_end < now()) then raise exception 'invalid_slot'; end if;
  z := public.zone_at(prop.lat, prop.lng);
  if z.id is null then raise exception 'outside_service_area'; end if;
  f := public.price_factors(p_service_type, prop.lat, prop.lng, z.id);
  select * into q from public.price_quote_full(p_service_type, p_gallons, public.is_peak(p_slot_start), false, 0,
                                               (f ->> 'distance_mult')::numeric, (f ->> 'demand_mult')::numeric);
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
   where id = p_order_id and org_id = org.id and status = 'pending_approval' and public.org_order_visible(org_id, property_id)
  returning * into o;
  if not found then raise exception 'not_found'; end if;
  return o;
end $$;

create or replace function public.org_cancel_order(p_order_id uuid, p_reason text default null)
returns public.orders
language plpgsql security definer set search_path = public
as $$
declare o public.orders; r text := public.my_org_role();
begin
  if r is null or r = 'finance' then raise exception 'forbidden_for_role'; end if;
  select * into o from public.orders where id = p_order_id and org_id = public.my_org_id() for update;
  if not found or not public.org_order_visible(o.org_id, o.property_id) then raise exception 'not_found'; end if;
  if r = 'site_manager' and o.customer_id is distinct from auth.uid() then raise exception 'not_found'; end if;
  if o.status not in ('pending_approval', 'scheduled', 'requested') then raise exception 'cannot_cancel'; end if;
  update public.orders
     set status = 'cancelled', cancelled_at = now(), cancelled_by = 'customer',
         cancel_reason = coalesce(nullif(left(btrim(coalesce(p_reason, '')), 300), ''), 'Cancelled by the business')
   where id = o.id returning * into o;
  if o.billing <> 'account' then perform public.refund_to_wallet(o.id, o.total, 'refund', 'Cancelled TO-' || o.order_no); end if;
  select * into o from public.orders where id = o.id;
  return o;
end $$;

-- Sites: a member limited to some sites edits only those; a site they add is added to their list.
create or replace function public.save_property(p_id uuid, p_label text, p_address text, p_area text, p_lat double precision, p_lng double precision, p_tank_gal integer)
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
    if org is not null and public.my_sites_restricted() then
      insert into public.org_member_sites (user_id, property_id, org_id, created_by) values (auth.uid(), p.id, org, auth.uid());
    end if;
  else
    update public.properties
       set label = btrim(p_label), address = coalesce(p_address, ''), area = coalesce(p_area, ''), lat = p_lat, lng = p_lng, tank_gal = coalesce(p_tank_gal, tank_gal)
     where id = p_id and ((org is null and customer_id = auth.uid()) or (org is not null and public.org_order_visible(org_id, id)))
    returning * into p;
    if not found then raise exception 'not_found'; end if;
  end if;
  return p;
end $$;

create or replace function public.delete_property(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if exists (select 1 from public.contracts where property_id = p_id and status in ('pending_owner', 'active', 'paused')) then raise exception 'property_has_contract'; end if;
  delete from public.properties
   where id = p_id and (customer_id = auth.uid() or (public.org_order_visible(org_id, id) and public.my_org_role() in ('admin', 'site_manager')));
  if not found then raise exception 'not_found'; end if;
end $$;

-- Invoices are organisation-wide: members limited to sites can't issue or pay them.
create or replace function public.org_generate_invoice()
returns public.invoices
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(public.my_org_role(), '') not in ('admin', 'finance') or public.my_sites_restricted() then raise exception 'forbidden_for_role'; end if;
  return public.invoice_org(public.my_org_id());
end $$;

create or replace function public.org_pay_invoice(p_invoice_id uuid)
returns public.invoices
language plpgsql security definer set search_path = public
as $$
declare inv public.invoices;
begin
  if coalesce(public.my_org_role(), '') not in ('admin', 'finance') or public.my_sites_restricted() then raise exception 'forbidden_for_role'; end if;
  update public.invoices set status = 'paid', paid_at = now() where id = p_invoice_id and org_id = public.my_org_id() and status <> 'paid' returning * into inv;
  if not found then raise exception 'not_found'; end if;
  update public.payments set status = 'captured', captured_at = now() where order_id in (select id from public.orders where invoice_id = inv.id) and status = 'on_account';
  update public.orders set payment_status = 'captured' where invoice_id = inv.id;
  return inv;
end $$;

create or replace function public.org_summary()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select to_jsonb(o) || jsonb_build_object('credit_used', public.org_outstanding(o.id), 'my_role', public.my_org_role(),
                                           'sites_restricted', public.my_sites_restricted(),
                                           'site_ids', coalesce((select jsonb_agg(s.property_id) from public.org_member_sites s where s.user_id = auth.uid()), '[]'::jsonb))
    from public.organizations o where o.id = public.my_org_id()
$$;

-- Refill reminders for business sites go to admins and site managers allowed on that site.
create or replace function public.send_refill_reminders()
returns integer
language plpgsql security definer set search_path = public
as $$
declare r record; n integer := 0; v jsonb;
begin
  for r in select x.* from public.refill_predictions() x
            where x.next_due_at <= now() + interval '1 day' and x.next_due_at > now() - interval '14 days'
              and not exists (select 1 from public.orders o where o.property_id = x.property_id
                                and o.status in ('scheduled', 'pending_approval', 'requested', 'accepted', 'arriving', 'arrived'))
              and not exists (select 1 from public.contracts k where k.property_id = x.property_id and k.status = 'active') loop
    insert into public.reminder_log (kind, subject_id, stage) values ('refill', r.property_id, to_char(r.next_due_at at time zone 'Asia/Muscat', 'YYYY-MM-DD'))
    on conflict do nothing;
    if not found then continue; end if;
    v := jsonb_build_object('property', r.label, 'days', round(r.avg_gap_days)::text, 'gallons', r.gallons::text,
                            'date', to_char(r.next_due_at at time zone 'Asia/Muscat', 'DD Mon'));
    if r.customer_id is not null then
      perform public.notify(r.customer_id, 'refill_reminder', null, v);
    else
      perform public.notify(m.id, 'refill_reminder', null, v)
         from public.profiles m
        where m.org_id = r.org_id and m.role = 'business' and m.org_role in ('admin', 'site_manager')
          and (not exists (select 1 from public.org_member_sites s where s.user_id = m.id)
               or exists (select 1 from public.org_member_sites s where s.user_id = m.id and s.property_id = r.property_id));
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- E17 — the business service-level page, per site, with the shared SLA rule (no row caps).
create function public.org_sla_summary(p_days integer default 30)
returns table (property_id uuid, label text, deliveries integer, on_time integer, late integer, late_minutes_avg numeric,
               ordered_gal bigint, metered_gal bigint, with_pod integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if public.my_org_id() is null then raise exception 'forbidden_for_role'; end if;
  return query
    select o.property_id, coalesce(p.label, 'Other / removed sites'),
           count(*)::int,
           count(*) filter (where public.sla_state(o) = 'on_time')::int,
           count(*) filter (where public.sla_state(o) = 'late')::int,
           round(avg(extract(epoch from public.sla_served_at(o) - public.sla_due_at(o)) / 60) filter (where public.sla_state(o) = 'late')::numeric, 0),
           coalesce(sum(o.gallons) filter (where d.order_id is not null), 0)::bigint,
           coalesce(sum(d.meter_gal), 0)::bigint,
           count(d.order_id)::int
      from public.orders o
      left join public.properties p on p.id = o.property_id
      left join public.pods d on d.order_id = o.id
     where public.org_order_visible(o.org_id, o.property_id) and not o.is_test and public.sla_served_at(o) is not null
       and public.sla_served_at(o) >= now() - make_interval(days => greatest(least(coalesce(p_days, 30), 366), 1))
     group by o.property_id, p.label;
end $$;

-- ===========================================================================
-- Access
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['storage_purge_queue', 'retention_runs', 'data_exports', 'org_member_sites'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
create policy storage_purge_queue_staff on public.storage_purge_queue for select to authenticated using (public.my_staff_role() = 'admin');
create policy retention_runs_staff on public.retention_runs for select to authenticated using (public.is_staff());
create policy data_exports_own on public.data_exports for select to authenticated using (customer_id = auth.uid() and expires_at > now());
create policy data_exports_staff on public.data_exports for select to authenticated using (public.my_staff_role() = 'admin');
-- The ciphertext columns (profiles.id_no_enc, companies.iban_enc) are not in the column
-- grants of 0011/0015, so they are never readable through the API.

revoke execute on function
  public.mask_tail(text), public.staff_privileged(), public.run_retention(boolean), public.customer_export(uuid), public.anonymise_customer(uuid),
  public.my_sites_restricted(), public.org_order_visible(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.mask_tail(text), public.staff_privileged(), public.my_sites_restricted(), public.org_order_visible(uuid, uuid) to authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'staff_private_profiles(uuid[])', 'staff_reveal_identity(uuid, text)', 'staff_reveal_contact(uuid, text)', 'staff_reveal_bank(uuid, text)',
    'staff_update_setting(text, jsonb, text)', 'staff_run_retention(boolean)', 'staff_process_data_request(uuid, text)', 'my_data_export(uuid)',
    'org_set_member_sites(uuid, uuid[])', 'org_create_orders(uuid, public.service_type, integer, integer, timestamptz, timestamptz, text, text, text)',
    'org_decide_order(uuid, boolean, text)', 'org_cancel_order(uuid, text)',
    'save_property(uuid, text, text, text, double precision, double precision, integer)', 'delete_property(uuid)',
    'org_generate_invoice()', 'org_pay_invoice(uuid)', 'org_summary()', 'org_sla_summary(integer)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Retention daily at 03:00 Muscat (23:00 UTC).
select public.nama_schedule('nama-retention', '0 23 * * *', 'select public.run_retention(false)');

alter publication supabase_realtime add table public.org_member_sites;
