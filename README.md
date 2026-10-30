# Nama Tanker — MVP

Water-tanker ordering with live tracking. Customers drop a pin, pick a service and volume, see the price, and watch the tanker drive to them. Drivers go online, see matching requests nearest first, accept one atomically, and stream GPS until delivery.

**Stack:** Next.js 16 (App Router, TypeScript) · Supabase (Auth, Postgres, RLS, Realtime) · MapLibre GL with OpenStreetMap raster tiles. Visual style follows `prototype.html`.

## Setup

Requires Node 20+ (tested on Node 24) and a Supabase project (the free tier is fine).

1. **Install**
   ```bash
   npm install
   ```
   `postinstall` copies MapLibre's web worker into `public/`.

2. **Create the database.** Put the Postgres connection string in `DATABASE_URL` (in `.env.local`, see step 4), then run:
   ```bash
   npm run db:apply
   ```
   It applies `supabase/migrations/NNNN_*.sql` in order, each in its own transaction, and records them in `supabase_migrations.schema_migrations` (the table the Supabase CLI uses), so it's safe to re-run. Already-applied migrations are skipped. It then checks the tables, RLS, RPCs and the realtime publication.
   Alternatives: paste each file into the dashboard's **SQL Editor** in order, or use `supabase link` + `supabase db push`.

3. **Configure auth.** Under **Authentication → URL Configuration**, set **Site URL** to `http://localhost:3000` and add `http://localhost:3000/auth/callback**` to **Redirect URLs** (the links carry `?app=…&next=…`: the app that asked for the email gets the session).
   For quick local testing you can turn off **Authentication → Providers → Email → Confirm email**, so new sign-ups land in the app straight away. Seeded accounts are pre-confirmed either way.
   **Mobile sign-in:** new accounts sign up with a mobile number, a password and an SMS code. Enable the Phone provider and the Send SMS hook (`public.send_sms_hook`) as described in [`docs/mobile-auth.md`](docs/mobile-auth.md); there is no SMS gateway yet, so for a demo also switch on `DEMO_SMS_CODES` to show the code on screen.

4. **Environment**
   ```bash
   cp .env.local.example .env.local
   ```
   Fill in values from **Project Settings → API**:

   | Variable | Where it's used |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | browser + server |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | browser + server (publishable key; the legacy anon key works too, also accepted as `NEXT_PUBLIC_SUPABASE_ANON_KEY`). RLS protects the data |
   | `DATABASE_URL` | `npm run db:apply` only (applies migrations with `pg`) |
   | `NEXT_PUBLIC_DEMO_MODE` | `true` shows the driver's **Simulate trip** button (demo only; leave unset in production) |
   | `NEXT_PUBLIC_OSRM_URL` | optional road-routing server for ETAs; defaults to the public OSRM demo server |
   | `SUPABASE_SERVICE_ROLE_KEY` | **`npm run seed` only.** Never referenced by app code; never prefix it with `NEXT_PUBLIC_` |

   `.env.local` is gitignored.

5. **Seed test accounts**
   ```bash
   npm run seed
   ```
   First set `SEED_PASSWORD` in `.env.local` (at least 12 characters, no default). The script fails without it. Both accounts use that password, and the script never prints it.

   | Role | Email | Mobile (sign in with either) |
   |---|---|---|
   | Customer | `customer@nama.test` | `+968 9124 4512` |
   | Driver | `driver@nama.test` (tanker `4521 TK`, DW, 5,000 gal, approved 12-month DW permit) | `+968 9555 0142` |
   | NWS admin | `nws-admin@nama.test` | — |
   | NWS operator | `nws-operator@nama.test` | — |
   | NWS permit officer | `nws-permits@nama.test` | — |

   The script is safe to re-run; it resets both accounts to the current `SEED_PASSWORD`.

6. **Run**
   ```bash
   npm run dev
   ```
   Open <http://localhost:3000>. Each app (NWS, Company, Business, Customer, Driver) keeps its own session (`lib/apps.ts`: one auth cookie per app), so one browser can be signed in to all of them at once, each with a different account. Each sign-in page accepts only its own kind of account.

## Try the flow

1. **Driver:** sign in and switch **Online**.
2. **Customer:** allow location (or drag the pin), choose **DW** and **1,000** gal, and check the quote (5.460 OMR). Then **Place request**.
3. **Driver:** the request appears instantly, showing area, distance and *you earn 2.975 OMR*. Tap **Accept job**.
4. **Customer:** the status changes to *Driver accepted*, then *On the way* after the first GPS ping, and the driver's name, plate and tanker marker appear.
5. **Driver:** on the Trip tab, tap **Simulate trip** (demo mode only). The app plays back a road route to the customer through the normal location updates, so the customer sees the tanker move, the "Last updated" label and the road ETA. Then tap **Mark arrived** and **Mark delivered**.

To see the race handling, open the driver screen in two browsers (a second driver needs their own account; sign up as Driver and register a DW tanker). Accept the same request in both. One wins, and the other gets **"Already taken"**.

Geolocation needs a secure context. `localhost` works. To test on a phone over your LAN, run `npx next dev --experimental-https`.

## How it works

### Data model (`supabase/migrations/`)
| Table | Purpose |
|---|---|
| `profiles` | one per auth user; `role` = `customer` \| `driver` \| `nws_staff` (+ `staff_role` for staff); created by a trigger from sign-up metadata, which can never produce staff |
| `tankers` | keyed by `id`: plate, `service_type` (DW/WW/TE), `capacity_gal`, `is_online`, GPS (`last_lat`, `last_lng`, `last_accuracy_m`, `last_fix_at`, `last_seen_at`), block state |
| `tanker_assignments` | which driver drives which tanker: `driver_id`, `tanker_id`, `assigned_at`, `unassigned_at`; at most one active assignment per driver and per tanker. **Driver assignment will move to the tanker company portal; NWS operator assignment stays as an override.** Until then, driver onboarding registers a tanker and assigns it to the driver |
| `permits` | per tanker: `permit_no`, `type`, `issued_at`, `expires_at`, `status` (pending/approved/rejected; "expired" is derived), reviewer and reason |
| `audit_log` | every staff action: actor, action, target, before/after, reason, time; append-only for everyone |
| `orders` | **`order_no`** (shown as `TO-<order_no>`), service, gallons, **area**, price lines (`numeric(10,3)` OMR), status, `driver_id` + `tanker_id`, driver name and plate snapshot, per-status timestamps |
| `order_locations` | the **exact** lat/lng and address, kept apart so RLS can hide it until a driver accepts |

Order numbers (`0002_order_no.sql`) come from the `orders_order_no_seq` sequence, starting at 48200. A trigger assigns the next number on every insert and ignores any value supplied, and another rejects changes. Clients have no access to the sequence, and the column is `NOT NULL` and `UNIQUE`. Orders that existed before the migration were numbered in `created_at` order.

Status: `requested → accepted → arriving → arrived → delivered`, or `requested → cancelled`. `arriving` is set automatically by the driver's first GPS ping after accepting.

Permits, blocks and GPS belong to the **tanker**, so they stay with it when it's reassigned to another driver. A tanker can go online or accept a job only if it isn't blocked and has an approved, unexpired permit for its own service type. This is enforced in the database (an online trigger, `accept_order` and `open_requests_near`), not just in the UI.

### NWS staff portal (`/nws`, `0008_nws_staff.sql`)
A desktop portal for NWS staff, styled after the prototype's staff screens.

- **Screens:**
  - **Live operations:** a map of online tankers and active orders, coloured by service. Tankers with no fix for over 60 s are grey. Counters update through Realtime.
  - **Orders:** filters and TO-number search. The detail page shows a status timeline, the driver, the tanker, and price lines with their rule tags.
  - **Fleet:** each tanker with its driver, last fix age and permit status. Operators can block, unblock, assign and unassign.
  - **Permits:** create, approve, reject with a reason, and resubmit after rejection, with a warning for permits expiring within 30 days.
  - **Pricing rules:** read-only, including `BILLING_MODE`.
  - **Audit log:** searchable, with before/after values.
- **Roles** (`profiles.staff_role`, strict):

  | Staff role | Can do |
  |---|---|
  | `operator` | block/unblock tankers (reason required), and the driver-assignment override |
  | `permit_officer` | create, approve, reject (reason required) and resubmit permits |
  | `admin` | grant or remove staff roles. An admin can't change their own role |

- **How writes work:**
  - Staff can read everything.
  - Every staff write is a `SECURITY DEFINER` RPC that checks the sub-role and writes exactly one `audit_log` row.
  - `audit_log` has no INSERT, UPDATE or DELETE grants, and a trigger rejects UPDATE, DELETE and TRUNCATE even for the database owner.
- **Accounts:** staff can't be created by sign-up; only `npm run seed` or an admin assigns the role. Seeded staff accounts (password: `SEED_PASSWORD`): `nws-admin@nama.test`, `nws-operator@nama.test`, `nws-permits@nama.test`. Staff sign in at `/login?app=nws` (the NWS sign-in accepts only staff accounts) and land on `/nws`.

### Pricing (`0004_pricing_rules.sql`)
Every tariff figure is a row in `public.pricing_rules` (`rule_key`, `value`, `status`, `source`, `notes`). Nothing is hard-coded in SQL or in `lib/pricing.ts`.

| Status | Rules |
|---|---|
| `confirmed` (tender tariff table) | DW up to 650 gal: 1 baisa/gal · WW 1 baisa/gal · TE 0.05 baisa/gal |
| `pending_clarification` | DW above 650 gal: 3 baisa/gal, applied as a **slab** today (Q05: slab vs whole volume) · VAT 5% on water + fee (Q07) |
| `assumption` | Delivery base fees DW 3.5 / WW 6 / TE 8 OMR · driver share 85% · peak 1.2× · priority 1.5× · monthly 10% / yearly 15% discount · cancel fee 1 OMR (the last five aren't used by the MVP) |

- **Pricing trigger:** a `BEFORE INSERT` trigger on `orders` prices every order from these rules and ignores any price supplied, then prices are frozen. Each order stores the status of the rules behind each line in `orders.price_basis`. The quote and driver earnings screens tag such lines **Assumption** or **Pending NWS clarification**.
- **`BILLING_MODE`:** a row in `public.app_settings`, `demo` by default. In `production` the trigger refuses to price an order if any rule it uses isn't `confirmed`, with an error that names those rules. It lives in the database because the database is what enforces it. To switch, run this as the database owner: `update app_settings set value = 'production' where key = 'BILLING_MODE';`
- **Changing a rule:** e.g. `update pricing_rules set value = 'whole_volume', status = 'confirmed', source = 'NWS reply to Q05' where rule_key = 'dw_above_650_basis';`. Signed-in users can read the rules; only the database owner can change them.
- **Rounding:** each line is rounded to 3 decimals (1 OMR = 1000 baisa). `lib/pricing.ts` mirrors `price_quote()` for the live quote only, and the tests check that the two agree on amounts and statuses.

### All writes go through RPCs
Signed-in users have **no** INSERT/UPDATE rights on `orders`. Every change is a `SECURITY DEFINER` function that checks the caller and the allowed transition:

| RPC | Who | What |
|---|---|---|
| `place_order` | customer | validates input, prices it, inserts the order and its location |
| `cancel_order` | owning customer | `UPDATE … WHERE status = 'requested'`; otherwise `cannot_cancel` |
| `open_requests_near(lat, lng)` | online driver | requests matching tanker type with gallons ≤ capacity, nearest first. Returns **area and distance only**, plus earnings |
| `accept_order` | online driver | **atomic:** `UPDATE … WHERE id = $1 AND status = 'requested' AND <tanker matches>`. Under concurrency exactly one caller gets the row; the others get `already_taken` |
| `report_location` | driver | stores the GPS fix; moves an accepted job to `arriving` |
| `mark_arrived`, `mark_delivered` | assigned driver | strict order: (accepted \| arriving) → arrived → delivered |

A **partial unique index** on `orders(driver_id) WHERE status IN ('accepted','arriving','arrived')` guarantees one active job per driver, even if two accepts race.

### Row Level Security
| Table | Customer | Driver |
|---|---|---|
| `orders` | own orders | open requests (`status = 'requested'`) + own jobs |
| `order_locations` | own | only the assigned job while it is active |
| `tankers` | only the tanker on **their own active order** | own tanker |
| `profiles` | own | own + the customer on their active job |

Users can edit only `full_name` and `phone` on their profile (a column-level grant), so nobody can change their own role. GPS columns on `tankers` are writable only through `report_location`.

### Realtime
- **Customer:** Postgres Changes on its order row (status) and on the assigned tanker row (position). The tanker marker glides between fixes.
- **Driver:** Postgres Changes `INSERT` on `orders` for new requests, plus updates on its own job.
- **Gap filler:** once a request is accepted or cancelled, RLS hides it from other drivers, so they never receive that UPDATE. The accepting driver and the cancelling customer send a Broadcast `gone` message on the `open-requests` channel, and the list also refreshes every 15 s. Broadcast is only a UI hint. Correctness comes from the atomic accept.
- If you enable **Realtime → Settings → "Private channels only"**, the `open-requests` broadcast stops working (the 15 s refresh still runs). Either leave public channels on, or add a `realtime.messages` policy for authenticated users.

### Live tracking
- **Driver phone:**
  - **Screen on:** while a job is active, the app holds a Screen Wake Lock and re-requests it when the page becomes visible again.
  - **Paused banner:** if location stops (permission denied, page hidden, or no fix for 30 s), a red **"Tracking paused — keep this screen open"** banner appears on every driver tab.
- **Sending rules (`lib/tracking.ts`):**
  - The phone reports whenever the driver is **online**, not only during a job, so the NWS Live operations board shows where idle tankers are. Going offline stops it.
  - Every 10 s while moving (more than 15 m from the last sent fix); otherwise at most every 30 s.
  - Each fix carries accuracy (m) and the device timestamp. Fixes worse than 100 m are dropped on the phone and rejected by `report_location` too, as are stale or out-of-order fixes.
- **Customer screen:**
  - **Freshness:** a "Last updated X ago" label under the tanker marker. After 60 s without an update the marker greys out and "Live location delayed" appears. The age is anchored to the server (`location_age_s`), not the customer's clock.
  - **ETA:** road routing via OSRM through one function, `routeEta()` in `lib/routing.ts`. The base URL is `NEXT_PUBLIC_OSRM_URL`, defaulting to `router.project-osrm.org` for the demo only. It recalculates at most every 30 s and falls back to a straight-line estimate when routing fails.
- **Demo simulator:** with `NEXT_PUBLIC_DEMO_MODE=true`, the driver's Trip tab offers **Simulate trip**. It plays back an OSRM road route in Muscat, from about 3 km away to the customer, feeding positions through the same fix handler and send rules as a real phone.
- **Privacy:**
  - Customers never send a live position. Their GPS is read only to pre-fill the delivery pin, and the only coordinates they send are that pin, via `place_order`.
  - A driver's position is visible only to the customer of the active order (accepted, arriving or arrived), through RLS on `tankers`, which Realtime also honours. It stops being visible on delivery or cancellation. Positions sent while idle are visible to NWS staff only.
  - In demo mode, the public OSRM server receives tanker and delivery coordinates.

### Testing live tracking on two phones
Phones only allow GPS and the wake lock on HTTPS (or `localhost`), so serve the app over HTTPS on your LAN:

1. On the computer: `npx next dev --experimental-https -H 0.0.0.0`. It prints a `https://<your-LAN-IP>:3000` URL. Add that URL and `/auth/callback` under Supabase **Authentication → URL Configuration**.
2. Put both phones on the same Wi-Fi and open the URL. Accept the self-signed certificate warning; the browser asks once.
3. **Phone A (customer):** sign in as `customer@nama.test` and allow location, which only pre-fills the pin. Request a tanker.
4. **Phone B (driver):** sign in as `driver@nama.test`, allow location, go **Online** on Jobs and accept the request. Keep the Trip tab open: the screen should stay on.
5. Walk or drive with phone B. Phone A shows the tanker moving, "Last updated … ago" and a road ETA, without reloading.
6. **Failure paths:**
   - Lock phone B or switch apps: when you come back, phone B shows **Tracking paused**.
   - After 60 s without updates, phone A greys the tanker out and shows **Live location delayed**.
   - Deny location on phone B: the banner says so.
7. Without walking: set `NEXT_PUBLIC_DEMO_MODE=true`, restart, and tap **Simulate trip** on phone B.
8. Finish with **Mark arrived** and **Mark delivered**. Phone A stops seeing the tanker.

### Testing from India (test zone)
NWS serves Oman only, but the developers and testers are in India. Migration `0020_test_zone_india.sql` adds a test service zone, **"Test – India"**: a box around mainland India (6.5–37.5° N, 68–97.5° E). It is **active by default**, so the customer and driver apps work end to end on real phones anywhere in India.

- **Customer:** a GPS fix in India pre-fills the delivery pin and centres the map (the app reads the active test zones' boxes and checks the fix on the phone; the position isn't sent). Orders there are priced by the same pricing rules as Muscat, in OMR. Sign up with an Indian mobile in international form (`+91…`).
- **Driver:** going online, GPS reporting, open requests nearest first and the whole trip work in India. On a test order the fill (DW/TE) and discharge (WW) steps are accepted wherever the tanker is, against the virtual sites **Test station** (`TEST-FILL`) and **Test plant** (`TEST-DIS`), and count as verified.
- **Oman is unchanged:** `zone_at()` ranks real zones before test zones and the box lies east of every Omani zone, so no Omani point ever resolves to it. Omani orders never use test sites, and Oman geofences, alerts and penalties apply as before (`npm run test:db`, section TZ).
- **NWS:** each order carries `orders.is_test`. Test orders are tagged **TEST** on Orders, the order page and Fleet trip logs, and left out of the Live operations and Orders KPIs, Reports, driver ratings on Complaints, business invoices (`invoice_org`) and outstanding B2B balances. No penalty is ever issued on a test order. Tankers and orders on the maps inside the test zone are labelled "TEST zone"; the Live operations tanker and alert counts leave them out.
- **Not separated:** payments, wallet and loyalty points, the company ledger (fill charges, earnings, tips) and payout batches, fraud flags, alerts (except the Live operations count), notifications, and the company and business portals. Drivers anywhere also see open requests from both Oman and India (sorted by distance).

**Switch it off for production** (and whenever nobody is testing): NWS → Settings → Zones and geofences → switch off "Test – India" (admin or control-room operator, with a reason, audited), or as the database owner:
```sql
update public.zones set active = false where is_test;
```
New orders in India are then refused (`zone_disabled`), and within 5 minutes the apps stop accepting Indian GPS fixes for the pin, with no rebuild. Test orders already in progress can finish. Switch it back on the same way.

### NWS tanker register, clusters and the permit campaign (`0031`–`0033`)
- **Clusters:** `clusters` and `governorates` (with the spellings in use, e.g. "Al Dakhiliyah" / "Ad Dakhiliyah"). In the NWS register every governorate sits in one cluster, so a tanker's cluster is its governorate's (`governorates.cluster_code`); admins can move a governorate under NWS → Settings → Clusters. Zones carry a governorate code, so orders report per governorate and cluster (Reports → Clusters). Fleet, Permits → Register / Campaign and Reports filter by cluster and governorate.
- **Two tanker counts:** `tankers.on_platform` (registered on this platform by a driver or company) and `tankers.in_register` (listed in the NWS register). Register-only tankers are offline with no driver and a 5,000 gal placeholder capacity (`capacity_known = false`); they can't go online, dispatch never ranks them, and Live operations and Fleet list on-platform tankers only. Screens label the counts "registered on platform" and "in NWS register".
- **Import:** NWS → Permits → Register → **Import register** (permit officers and admins). CSV only (no spreadsheet parser is installed: save Excel files as CSV UTF-8). Columns are matched to the NWS export, with a mapping step if the headers differ; the preview shows rows OK / with warnings / with errors and duplicates in the file and against the database. Rows go to `staff_import_register` in chunks of 500 and are checked again there; the import is idempotent by plate. Valid → an approved permit, In Progress → an application at the submitted stage, No Permit → none. Owners become `registry_owners` (not sign-in accounts); each import is an `import_batches` row with counts and a downloadable error report, and is audit-logged.
- **Claiming:** when a registry owner signs up and verifies the same mobile number, the entry links to the account; an owner account with a company takes over its register tankers. A driver or owner registering a register plate adopts that tanker (if the verified number matches, or the register has none), else `plate_in_register`.
- **Campaign:** NWS → Permits → Campaign: the funnel in register → invited → registered → applied → under review → permitted, by cluster and governorate, plus expiring and expired; each step drills down to its tankers (CSV export) and owners not yet on the platform can be invited by SMS (template `registry_invite`, EN/AR) through the notification outbox: throttled (`REGISTRY_INVITES`: daily cap, rate, cooldown, max invitations) and consent-aware (opt-outs, an account's SMS switch).
- **Script:** `npm run import:register` validates `data-private/tankers-demo-anonymised.csv` (or a path) with the same rules and prints counts only; `-- --confirm-live` imports it into the configured project as a permit officer (`IMPORT_EMAIL` / `IMPORT_PASSWORD`, default the seeded permit officer and `SEED_PASSWORD`) through the same RPCs. The real register (`Tankers Data*.csv`) is confidential and gitignored; the script refuses it unless `--real-register` is given.

### Demo activity for the NWS board
`npm run demo` drives the seeded accounts through one full job so the Live operations board has something on it: 4521 TK goes online and waits (about 40 s), the customer requests DW 3,000 gal in Al Khuwair, the driver accepts after 20 s, drives a simulated road route (about 3.6 km, reporting every 10 s), arrives, delivers and goes offline. It takes about 8 minutes. `npm run demo -- --idle` just keeps the tanker online and reporting from one spot until Ctrl+C.

It signs in with the publishable key and `SEED_PASSWORD` and calls the same RPCs as the app, so RLS and the permit and block rules apply; it never uses the service-role key. Ctrl+C sets the tanker offline and cancels or finishes the order it created. Orders it creates are real rows for the seeded customer. Don't run it while you're using `driver@nama.test` on a phone.

## Tests
```bash
npm run test:unit            # sending rules, OSRM fallback, customer-privacy source check
npm run test:db              # all database suites on PGlite (fresh database from the migrations)
npm run test:db:supabase     # the same suites on the Supabase project (test-prefixed users, deleted afterwards)
npm run evidence             # both database runs + docs/evidence/test-report.md
```
The database suites cover:
- the authorization matrix (anon, customer, other customer, driver, other driver × every table and RPC)
- the order lifecycle and order numbers
- pricing rules and `BILLING_MODE`
- races: 20 drivers on one order, and one driver on two orders
- GPS freshness and accuracy
- location privacy, including Realtime on Supabase
- the India test zone: Indian cities resolve to it, Omani points never do, test trips and the switch, Oman geofences unchanged

The Supabase run fingerprints every non-test row before and after, and fails if anything changed. See [docs/evidence/test-report.md](docs/evidence/test-report.md).

`npm run lint` and `npm run build` should both be clean.

## Project layout
```
app/
  login, signup, auth/callback      sign-in (mobile or email + password), sign-up, reset; ?app= picks the app, which admits only its own accounts
  onboarding/                       driver: plate, type, capacity
  customer/                         map picker + quote + place request
  customer/orders/[id]/             live status, driver card, moving tanker
  driver/                           online toggle, requests, active job + GPS
components/                         MapView (MapLibre), order UI, shell
lib/                                pricing, Supabase clients, types, geo, error copy
proxy.ts                            session refresh + optimistic redirects (Next 16 "proxy")
supabase/migrations/0001_init.sql   schema, RLS, RPCs, realtime publication
supabase/migrations/0002_order_no.sql  sequential order numbers (TO-48200…)
supabase/migrations/0003…0005       GPS freshness, pricing rules + BILLING_MODE, fix accuracy
scripts/apply-migration.mjs         npm run db:apply: ordered, tracked migrations
supabase/tests/                     portable DB suites (PGlite + Supabase); tests/unit/ client rules
docs/evidence/                      test report, raw output, architecture, prototype labelling
scripts/seed.ts                     test customer + driver (service-role key)
```

## Known limits (MVP)
- No payments, ratings, push notifications, scheduling or admin screens. Customers can cancel only before acceptance.
- `open_requests_near` uses straight-line (haversine) distance, not road distance. Distances are rounded to 0.1 km.
- Tiles come from `tile.openstreetmap.org`, and the area name is suggested by OSM Nominatim from the customer's browser (the pin's coordinates are sent to it). Both are fine for development under their usage policies. For production, use a tile and geocoding provider.
- Location is sent only while the driver app is in the foreground with the screen on (the wake lock helps; browsers stop GPS in the background). A production driver app needs a native wrapper for background location.
- `router.project-osrm.org` is a public demo server with no availability guarantee; use a self-hosted OSRM (`NEXT_PUBLIC_OSRM_URL`) beyond demos.
