-- Full platform schema: tanker companies, business accounts, service zones and
-- fill/discharge sites, properties, multi-leg trips with proof of delivery,
-- payments and ledgers, ratings, messaging, documents and water tests, IVMS
-- devices and GPS history, complaints, alerts, penalties, inspections,
-- notifications, contracts, invoices, promotions, incidents, integrations,
-- fraud flags and data requests.
--
-- Access model is unchanged: signed-in users only ever SELECT (through RLS);
-- every write is a SECURITY DEFINER RPC (0011). Staff read everything.

-- ---------------------------------------------------------------------------
-- Organisations
-- ---------------------------------------------------------------------------
create table public.companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 2 and 120),
  cr_no      text not null unique check (char_length(btrim(cr_no)) between 3 and 30),
  phone      text check (char_length(phone) <= 32),
  email      text check (char_length(email) <= 120),
  bank_name  text check (char_length(bank_name) <= 80),
  iban       text check (char_length(iban) <= 40),
  rating     numeric(2,1) not null default 4.5 check (rating between 0 and 5),
  since      date not null default current_date,
  status     text not null default 'active' check (status in ('pending', 'active', 'suspended')),
  created_at timestamptz not null default now()
);

create table public.organizations (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(btrim(name)) between 2 and 120),
  cr_no          text not null unique check (char_length(btrim(cr_no)) between 3 and 30),
  segment        text not null default 'commercial' check (segment in ('commercial', 'government', 'industrial', 'farm')),
  credit_limit   numeric(12,3) not null default 0 check (credit_limit >= 0),
  terms_days     integer not null default 30 check (terms_days between 0 and 120),
  approval_limit numeric(12,3) not null default 50 check (approval_limit >= 0),
  invoicing      text not null default 'monthly' check (invoicing in ('monthly', 'weekly')),
  paused         boolean not null default false,
  status         text not null default 'active' check (status in ('pending', 'active', 'suspended')),
  created_at     timestamptz not null default now()
);

alter table public.profiles
  add column company_id     uuid references public.companies (id) on delete set null,
  add column org_id         uuid references public.organizations (id) on delete set null,
  add column org_role       text check (org_role in ('admin', 'site_manager', 'finance')),
  add column id_type        text check (id_type in ('civil_id', 'resident_card', 'passport')),
  add column id_no          text check (char_length(id_no) <= 30),
  add column id_verified    boolean not null default false,
  add column segment        text not null default 'household' check (segment in ('household', 'commercial', 'government', 'farm')),
  add column lang           text not null default 'en' check (lang in ('en', 'ar')),
  add column prefs          jsonb not null default '{}'::jsonb,
  add column account_blocked boolean not null default false,
  add column loyalty_points integer not null default 0 check (loyalty_points >= 0),
  add column staff_zones    text[] not null default '{}';

-- Users may edit their language and preferences as well as name and phone.
grant update (lang, prefs) on public.profiles to authenticated;

alter table public.tankers add column company_id uuid references public.companies (id) on delete set null;
create index tankers_company_idx on public.tankers (company_id);

-- ---------------------------------------------------------------------------
-- Geography: service zones, filling stations and discharge sites
-- ---------------------------------------------------------------------------
create table public.zones (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  governorate text not null,
  center_lat  double precision not null check (center_lat between -90 and 90),
  center_lng  double precision not null check (center_lng between -180 and 180),
  radius_km   numeric(6,2) not null check (radius_km > 0),
  active      boolean not null default true
);

create table public.sites (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  kind          text not null check (kind in ('fill', 'discharge')),
  name          text not null,
  service_types public.service_type[] not null,
  lat           double precision not null check (lat between -90 and 90),
  lng           double precision not null check (lng between -180 and 180),
  radius_m      integer not null default 250 check (radius_m between 25 and 5000),
  operator      text not null default 'NWS',
  active        boolean not null default true
);

create table public.properties (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid references public.profiles (id) on delete cascade,
  org_id      uuid references public.organizations (id) on delete cascade,
  label       text not null check (char_length(btrim(label)) between 1 and 80),
  address     text not null default '' check (char_length(address) <= 300),
  area        text not null default '' check (char_length(area) <= 120),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  tank_gal    integer not null default 3000 check (tank_gal between 100 and 100000),
  created_at  timestamptz not null default now(),
  check (customer_id is not null or org_id is not null)
);
create index properties_customer_idx on public.properties (customer_id);
create index properties_org_idx on public.properties (org_id);

-- ---------------------------------------------------------------------------
-- Contracts (recurring deliveries) and promotions — referenced by orders
-- ---------------------------------------------------------------------------
create sequence public.contracts_no_seq as bigint start with 2201;
create table public.contracts (
  id           uuid primary key default gen_random_uuid(),
  contract_no  bigint not null unique default nextval('public.contracts_no_seq'),
  customer_id  uuid references public.profiles (id) on delete cascade,
  org_id       uuid references public.organizations (id) on delete cascade,
  property_id  uuid not null references public.properties (id) on delete cascade,
  company_id   uuid not null references public.companies (id) on delete restrict,
  service_type public.service_type not null,
  gallons      integer not null check (gallons between 100 and 20000),
  frequency    text not null check (frequency in ('weekly', 'biweekly', 'monthly')),
  plan         text not null check (plan in ('monthly', 'yearly')),
  slot         text not null default 'morning' check (slot in ('morning', 'evening')),
  start_date   date not null,
  end_date     date not null,
  monthly_est  numeric(10,3) not null default 0,
  status       text not null default 'pending_owner' check (status in ('pending_owner', 'active', 'paused', 'ended', 'declined')),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  check (end_date > start_date),
  check (customer_id is not null or org_id is not null)
);

create table public.promotions (
  code       text primary key check (code ~ '^[A-Z0-9]{3,20}$'),
  label      text not null,
  pct        numeric(4,3) not null check (pct > 0 and pct <= 0.5),
  audience   text not null default 'all' check (audience in ('all', 'new', 'household', 'business')),
  max_uses   integer not null default 1000,
  uses       integer not null default 0,
  active     boolean not null default true,
  valid_to   date
);

-- ---------------------------------------------------------------------------
-- Orders: scheduling, channels, payment, trip legs, rating
-- ---------------------------------------------------------------------------
alter table public.orders
  add column property_id        uuid references public.properties (id) on delete set null,
  add column org_id             uuid references public.organizations (id) on delete set null,
  add column contract_id        uuid references public.contracts (id) on delete set null,
  add column zone_id            uuid references public.zones (id) on delete set null,
  add column channel            text not null default 'app' check (channel in ('app', 'call_centre', 'business', 'contract')),
  add column genesys_id         text,
  add column is_emergency       boolean not null default false,
  add column slot_start         timestamptz,
  add column slot_end           timestamptz,
  add column slot_label         text,
  add column slot_peak          boolean not null default false,
  add column driver_note        text check (char_length(driver_note) <= 300),
  add column po_number          text check (char_length(po_number) <= 40),
  add column billing            text not null default 'prepaid' check (billing in ('prepaid', 'account')),
  add column promo_code         text,
  add column discount           numeric(10,3) not null default 0,
  add column pay_method         text check (pay_method in ('wallet', 'card', 'omannet', 'wallet_card', 'account', 'cash')),
  add column payment_status     text check (payment_status in ('authorized', 'captured', 'refunded', 'partially_refunded', 'failed', 'on_account')),
  add column released_at        timestamptz,
  add column approved_by        uuid references public.profiles (id) on delete set null,
  add column approved_at        timestamptz,
  add column filled_at          timestamptz,
  add column fill_site_id       uuid references public.sites (id) on delete set null,
  add column fill_meter_gal     integer,
  add column fill_verified      boolean,
  add column collected_at       timestamptz,
  add column discharged_at      timestamptz,
  add column discharge_site_id  uuid references public.sites (id) on delete set null,
  add column discharge_verified boolean,
  add column rating             smallint check (rating between 1 and 5),
  add column rating_comment     text check (char_length(rating_comment) <= 500),
  add column tip                numeric(10,3) not null default 0 check (tip >= 0),
  add column rated_at           timestamptz,
  add column cancel_fee         numeric(10,3) not null default 0,
  add column cancelled_by       text check (cancelled_by in ('customer', 'driver', 'staff', 'system', 'approver')),
  add column cancel_reason      text check (char_length(cancel_reason) <= 300);

create index orders_status_idx on public.orders (status, created_at desc);
create index orders_tanker_idx on public.orders (tanker_id, created_at desc);
create index orders_org_idx on public.orders (org_id, created_at desc);
create index orders_contract_idx on public.orders (contract_id, slot_start);

-- A wastewater job stays active until it is discharged: one active job per driver/tanker.
drop index public.orders_one_active_job_per_driver;
create unique index orders_one_active_job_per_driver on public.orders (driver_id) where status in ('accepted', 'arriving', 'arrived', 'collected');
drop index public.orders_one_active_job_per_tanker;
create unique index orders_one_active_job_per_tanker on public.orders (tanker_id) where status in ('accepted', 'arriving', 'arrived', 'collected');

-- ---------------------------------------------------------------------------
-- Payments and ledgers (OMR, 3 decimals). Signed amounts: + credits the account.
-- ---------------------------------------------------------------------------
create table public.payments (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders (id) on delete cascade,
  customer_id     uuid references public.profiles (id) on delete set null,
  org_id          uuid references public.organizations (id) on delete set null,
  method          text not null check (method in ('wallet', 'card', 'omannet', 'wallet_card', 'account', 'cash')),
  amount          numeric(10,3) not null check (amount >= 0),
  wallet_amount   numeric(10,3) not null default 0,
  card_amount     numeric(10,3) not null default 0,
  card_last4      text check (card_last4 ~ '^[0-9]{4}$'),
  status          text not null check (status in ('authorized', 'captured', 'refunded', 'partially_refunded', 'failed', 'on_account')),
  gateway_ref     text,
  failure_reason  text,
  refunded_amount numeric(10,3) not null default 0,
  created_at      timestamptz not null default now(),
  captured_at     timestamptz
);
create index payments_order_idx on public.payments (order_id);
create index payments_created_idx on public.payments (created_at desc);

create table public.payment_methods (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles (id) on delete cascade,
  brand       text not null check (brand in ('Visa', 'Mastercard', 'OmanNet')),
  last4       text not null check (last4 ~ '^[0-9]{4}$'),
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);

create table public.wallet_tx (
  id          bigint generated always as identity primary key,
  customer_id uuid not null references public.profiles (id) on delete cascade,
  kind        text not null check (kind in ('topup', 'payment', 'refund', 'goodwill', 'tip', 'cancel_fee', 'loyalty', 'adjustment')),
  amount      numeric(10,3) not null,
  order_id    uuid references public.orders (id) on delete set null,
  memo        text not null default '',
  created_at  timestamptz not null default now()
);
create index wallet_tx_customer_idx on public.wallet_tx (customer_id, created_at desc);

create sequence public.payout_batches_no_seq as bigint start with 501;
create table public.payout_batches (
  id         uuid primary key default gen_random_uuid(),
  batch_no   bigint not null unique default nextval('public.payout_batches_no_seq'),
  run_by     uuid references public.profiles (id) on delete set null,
  total      numeric(12,3) not null,
  companies  integer not null,
  created_at timestamptz not null default now()
);

create table public.company_tx (
  id              bigint generated always as identity primary key,
  company_id      uuid not null references public.companies (id) on delete cascade,
  driver_id       uuid references public.profiles (id) on delete set null,
  tanker_id       uuid references public.tankers (id) on delete set null,
  bucket          text not null default 'earnings' check (bucket in ('earnings', 'fill_credit')),
  kind            text not null check (kind in ('earning', 'tip', 'cancel_fee', 'penalty', 'penalty_reversal', 'payout', 'fill_topup', 'fill_charge')),
  amount          numeric(12,3) not null,
  order_id        uuid references public.orders (id) on delete set null,
  penalty_id      uuid,
  payout_batch_id uuid references public.payout_batches (id) on delete set null,
  memo            text not null default '',
  created_at      timestamptz not null default now()
);
create index company_tx_company_idx on public.company_tx (company_id, created_at desc);
create index company_tx_driver_idx on public.company_tx (driver_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Trip evidence: proof of delivery/collection, station and sensor events, GPS history
-- ---------------------------------------------------------------------------
create table public.pods (
  order_id        uuid primary key references public.orders (id) on delete cascade,
  kind            text not null check (kind in ('delivery', 'collection')),
  photo_path      text,
  photo_hash      text,
  meter_gal       integer not null check (meter_gal between 0 and 20000),
  signature_path  text,
  signature_svg   text check (char_length(signature_svg) <= 60000),
  no_signature    boolean not null default false,
  left_at_tank    boolean not null default false,
  lat             double precision,
  lng             double precision,
  created_at      timestamptz not null default now(),
  status          text not null default 'accepted' check (status in ('accepted', 'rejected')),
  rejected_reason text,
  rejected_by     uuid references public.profiles (id) on delete set null,
  rejected_at     timestamptz
);
create index pods_photo_hash_idx on public.pods (photo_hash);

create table public.source_events (
  id         bigint generated always as identity primary key,
  order_id   uuid references public.orders (id) on delete cascade,
  tanker_id  uuid references public.tankers (id) on delete cascade,
  source     text not null check (source in ('tfs', 'ivms', 'stp', 'tas')),
  kind       text not null check (kind in ('fill', 'discharge', 'valve_open', 'signal')),
  site_id    uuid references public.sites (id) on delete set null,
  meter_gal  integer,
  lat        double precision,
  lng        double precision,
  verified   boolean not null,
  note       text not null default '',
  created_at timestamptz not null default now()
);
create index source_events_order_idx on public.source_events (order_id);

create table public.gps_fixes (
  id          bigint generated always as identity primary key,
  tanker_id   uuid not null references public.tankers (id) on delete cascade,
  order_id    uuid references public.orders (id) on delete set null,
  lat         double precision not null,
  lng         double precision not null,
  accuracy_m  double precision,
  speed_kmh   numeric(6,1),
  recorded_at timestamptz not null
);
create index gps_fixes_tanker_idx on public.gps_fixes (tanker_id, recorded_at desc);

create table public.order_messages (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders (id) on delete cascade,
  sender_id   uuid references public.profiles (id) on delete set null,
  sender_role text not null check (sender_role in ('customer', 'driver', 'staff')),
  body        text not null check (char_length(btrim(body)) between 1 and 500),
  created_at  timestamptz not null default now()
);
create index order_messages_order_idx on public.order_messages (order_id, created_at);

-- ---------------------------------------------------------------------------
-- Fleet compliance: documents, water tests, IVMS devices, shift checks, availability
-- ---------------------------------------------------------------------------
create table public.tanker_documents (
  id          uuid primary key default gen_random_uuid(),
  tanker_id   uuid references public.tankers (id) on delete cascade,
  driver_id   uuid references public.profiles (id) on delete cascade,
  kind        text not null check (kind in ('mulkiya', 'tank_cleanliness', 'rop_inspection', 'insurance', 'ivms_certificate', 'heavy_licence', 'water_test')),
  ref_no      text not null default '',
  valid_to    date not null,
  file_path   text,
  status      text not null default 'valid' check (status in ('valid', 'pending_review', 'rejected')),
  uploaded_at timestamptz not null default now(),
  check (tanker_id is not null or driver_id is not null)
);
create index tanker_documents_tanker_idx on public.tanker_documents (tanker_id, kind);
create index tanker_documents_driver_idx on public.tanker_documents (driver_id, kind);

create table public.water_tests (
  id         uuid primary key default gen_random_uuid(),
  tanker_id  uuid not null references public.tankers (id) on delete cascade,
  cert_no    text not null unique,
  tested_at  date not null,
  chlorine   numeric(4,2) not null,
  turbidity  numeric(4,2) not null,
  tds        integer not null,
  ph         numeric(3,1) not null,
  ecoli      text not null default 'Not detected',
  coliforms  text not null default 'Not detected',
  passed     boolean not null
);
create index water_tests_tanker_idx on public.water_tests (tanker_id, tested_at desc);

create table public.devices (
  id           text primary key check (id ~ '^IV-[0-9]{4,6}$'),
  tanker_id    uuid unique references public.tankers (id) on delete set null,
  firmware     text not null default '4.2.1',
  sensors      jsonb not null default '{"gps": true, "valve": true, "flow_meter": true, "pump": true, "door": true}'::jsonb,
  installed_at date not null default current_date
);

create table public.shift_checks (
  id         uuid primary key default gen_random_uuid(),
  driver_id  uuid not null references public.profiles (id) on delete cascade,
  tanker_id  uuid references public.tankers (id) on delete set null,
  day        date not null default current_date,
  items      jsonb not null,
  created_at timestamptz not null default now(),
  unique (driver_id, day)
);

create table public.driver_availability (
  driver_id uuid not null references public.profiles (id) on delete cascade,
  weekday   smallint not null check (weekday between 0 and 6),
  available boolean not null default true,
  shift     text not null default 'day' check (shift in ('day', 'evening', 'night')),
  primary key (driver_id, weekday)
);

create table public.trip_issues (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid references public.orders (id) on delete set null,
  driver_id  uuid references public.profiles (id) on delete set null,
  tanker_id  uuid references public.tankers (id) on delete set null,
  kind       text not null check (kind in ('breakdown', 'customer_unreachable', 'wrong_address', 'station_closed', 'accident')),
  note       text not null default '',
  released   boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Complaints / cases
-- ---------------------------------------------------------------------------
create table public.complaint_sla (
  category text primary key,
  label    text not null,
  hours    integer not null check (hours between 1 and 720),
  team     text not null
);

create sequence public.complaints_no_seq as bigint start with 3101;
create table public.complaints (
  id            uuid primary key default gen_random_uuid(),
  case_no       bigint not null unique default nextval('public.complaints_no_seq'),
  order_id      uuid references public.orders (id) on delete set null,
  customer_id   uuid references public.profiles (id) on delete set null,
  category      text not null references public.complaint_sla (category),
  description   text not null check (char_length(btrim(description)) between 3 and 2000),
  photo_path    text,
  channel       text not null default 'app' check (channel in ('app', 'call_centre', 'business')),
  genesys_id    text,
  state         text not null default 'new' check (state in ('new', 'assigned', 'escalated', 'resolved')),
  owner_team    text,
  sla_hours     integer not null,
  due_at        timestamptz not null,
  refund_amount numeric(10,3) not null default 0,
  resolution    text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index complaints_state_idx on public.complaints (state, due_at);
create index complaints_customer_idx on public.complaints (customer_id, created_at desc);

create table public.complaint_notes (
  id           bigint generated always as identity primary key,
  complaint_id uuid not null references public.complaints (id) on delete cascade,
  author_id    uuid references public.profiles (id) on delete set null,
  author_role  text not null,
  body         text not null check (char_length(btrim(body)) between 1 and 2000),
  internal     boolean not null default false,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Control room: alerts, penalties, inspections
-- ---------------------------------------------------------------------------
create table public.alerts (
  id          bigint generated always as identity primary key,
  tanker_id   uuid references public.tankers (id) on delete cascade,
  order_id    uuid references public.orders (id) on delete set null,
  type        text not null,
  severity    text not null check (severity in ('high', 'med', 'low')),
  message     text not null,
  lat         double precision,
  lng         double precision,
  state       text not null default 'open' check (state in ('open', 'acknowledged', 'resolved')),
  dedupe_key  text,
  created_at  timestamptz not null default now(),
  acted_by    uuid references public.profiles (id) on delete set null,
  acted_at    timestamptz,
  action_note text
);
create index alerts_state_idx on public.alerts (state, created_at desc);
create unique index alerts_open_dedupe on public.alerts (dedupe_key) where state <> 'resolved' and dedupe_key is not null;

create table public.penalty_rules (
  code         text primary key,
  label        text not null,
  party        text not null check (party in ('driver', 'customer', 'business')),
  amount       numeric(10,3) not null check (amount >= 0),
  amount_kind  text not null default 'omr' check (amount_kind in ('omr', 'pct')),
  compensation text not null default '',
  active       boolean not null default true
);

create sequence public.penalties_no_seq as bigint start with 7101;
create table public.penalties (
  id           uuid primary key default gen_random_uuid(),
  penalty_no   bigint not null unique default nextval('public.penalties_no_seq'),
  rule_code    text not null references public.penalty_rules (code),
  company_id   uuid references public.companies (id) on delete set null,
  tanker_id    uuid references public.tankers (id) on delete set null,
  driver_id    uuid references public.profiles (id) on delete set null,
  order_id     uuid references public.orders (id) on delete set null,
  customer_id  uuid references public.profiles (id) on delete set null,
  org_id       uuid references public.organizations (id) on delete set null,
  amount       numeric(10,3) not null check (amount >= 0),
  reason       text not null,
  evidence     text not null default '',
  state        text not null default 'issued' check (state in ('issued', 'disputed', 'upheld', 'cancelled')),
  dispute_text text,
  disputed_at  timestamptz,
  decided_by   uuid references public.profiles (id) on delete set null,
  decided_at   timestamptz,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index penalties_company_idx on public.penalties (company_id, created_at desc);

create table public.inspections (
  id           uuid primary key default gen_random_uuid(),
  tanker_id    uuid not null references public.tankers (id) on delete cascade,
  permit_id    uuid references public.permits (id) on delete set null,
  inspector_id uuid references public.profiles (id) on delete set null,
  result       text not null check (result in ('scheduled', 'pass', 'fail')),
  notes        text not null default '',
  checklist    jsonb not null default '{}'::jsonb,
  scheduled_for date,
  created_at   timestamptz not null default now()
);

alter table public.permits
  add column stage          text not null default 'submitted' check (stage in ('submitted', 'documents', 'inspection', 'decision')),
  add column info_requested text,
  add column applied_by     uuid references public.profiles (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
create table public.notification_templates (
  event    text primary key,
  label    text not null,
  audience text not null check (audience in ('customer', 'driver', 'owner', 'business')),
  title_en text not null,
  body_en  text not null,
  title_ar text not null,
  body_ar  text not null,
  push     boolean not null default true,
  sms      boolean not null default true,
  whatsapp boolean not null default false
);

create table public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  event      text not null,
  channels   text[] not null default '{push}',
  title      text not null,
  body       text not null,
  order_id   uuid references public.orders (id) on delete set null,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- B2B invoices
-- ---------------------------------------------------------------------------
create sequence public.invoices_no_seq as bigint start with 9301;
create table public.invoices (
  id           uuid primary key default gen_random_uuid(),
  invoice_no   bigint not null unique default nextval('public.invoices_no_seq'),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  period_start date not null,
  period_end   date not null,
  orders       integer not null default 0,
  subtotal     numeric(12,3) not null,
  vat          numeric(12,3) not null,
  total        numeric(12,3) not null,
  status       text not null default 'issued' check (status in ('issued', 'paid', 'overdue')),
  issued_at    timestamptz not null default now(),
  due_at       timestamptz not null,
  paid_at      timestamptz
);
alter table public.orders add column invoice_id uuid references public.invoices (id) on delete set null;

-- ---------------------------------------------------------------------------
-- System: incidents, integrations, fraud flags, data requests, scheduled reports
-- ---------------------------------------------------------------------------
create table public.incident_targets (
  priority     text primary key check (priority in ('P1', 'P2', 'P3', 'P4')),
  label        text not null,
  response_min integer not null,
  resolve_min  integer not null
);

create sequence public.incidents_no_seq as bigint start with 401;
create table public.incidents (
  id              uuid primary key default gen_random_uuid(),
  inc_no          bigint not null unique default nextval('public.incidents_no_seq'),
  priority        text not null references public.incident_targets (priority),
  title           text not null,
  system          text not null,
  state           text not null default 'open' check (state in ('open', 'acknowledged', 'resolved')),
  owner           text not null default 'Platform on-call',
  notes           text not null default '',
  opened_at       timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at     timestamptz
);

create table public.integrations (
  key          text primary key,
  name         text not null,
  purpose      text not null,
  status       text not null default 'simulated' check (status in ('ok', 'warn', 'down', 'simulated')),
  last_test_at timestamptz,
  latency_ms   integer,
  note         text not null default 'Simulated — interface spec pending'
);

create table public.fraud_flags (
  id           bigint generated always as identity primary key,
  rule         text not null,
  subject_type text not null,
  subject_id   text not null,
  details      text not null,
  score        integer not null default 50 check (score between 0 and 100),
  state        text not null default 'open' check (state in ('open', 'cleared', 'confirmed')),
  dedupe_key   text not null unique,
  created_at   timestamptz not null default now(),
  decided_by   uuid references public.profiles (id) on delete set null
);

create sequence public.data_requests_no_seq as bigint start with 112;
create table public.data_requests (
  id          uuid primary key default gen_random_uuid(),
  ref_no      bigint not null unique default nextval('public.data_requests_no_seq'),
  customer_id uuid references public.profiles (id) on delete set null,
  kind        text not null check (kind in ('access', 'delete', 'correct')),
  details     text not null default '',
  state       text not null default 'open' check (state in ('open', 'completed', 'rejected')),
  created_at  timestamptz not null default now(),
  closed_at   timestamptz,
  closed_by   uuid references public.profiles (id) on delete set null
);

create table public.scheduled_reports (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  dataset    text not null,
  group_by   text not null default 'day',
  cadence    text not null check (cadence in ('daily', 'weekly', 'monthly')),
  format     text not null default 'csv' check (format in ('csv', 'xlsx', 'pdf')),
  recipients text not null default '',
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS: enable everywhere, revoke direct writes, grant SELECT (policies decide rows)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['companies', 'organizations', 'zones', 'sites', 'properties', 'contracts', 'promotions',
    'payments', 'payment_methods', 'wallet_tx', 'payout_batches', 'company_tx', 'pods', 'source_events', 'gps_fixes',
    'order_messages', 'tanker_documents', 'water_tests', 'devices', 'shift_checks', 'driver_availability', 'trip_issues',
    'complaint_sla', 'complaints', 'complaint_notes', 'alerts', 'penalty_rules', 'penalties', 'inspections',
    'notification_templates', 'notifications', 'invoices', 'incident_targets', 'incidents', 'integrations',
    'fraud_flags', 'data_requests', 'scheduled_reports']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

revoke all on sequence public.contracts_no_seq, public.payout_batches_no_seq, public.complaints_no_seq, public.penalties_no_seq,
  public.invoices_no_seq, public.incidents_no_seq, public.data_requests_no_seq from anon, authenticated;
