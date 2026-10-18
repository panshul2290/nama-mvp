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

3. **Configure auth.** Under **Authentication → URL Configuration**, set **Site URL** to `http://localhost:3000` and add `http://localhost:3000/auth/callback` to **Redirect URLs**.
   For quick local testing you can turn off **Authentication → Providers → Email → Confirm email**, so new sign-ups land in the app straight away. Seeded accounts are pre-confirmed either way.

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
   | Role | Email | Password |
   |---|---|---|
   | Customer | `customer@nama.test` | `Tanker-test-2026` |
   | Driver | `driver@nama.test` | `Tanker-test-2026` (tanker `4521 TK`, DW, 5,000 gal) |

   Set `SEED_PASSWORD` to change the password. The script is safe to re-run.

6. **Run**
   ```bash
   npm run dev
   ```
   Open <http://localhost:3000>. To use both roles at once, sign in as the customer in one browser and the driver in another (or a private window), because they share a session cookie otherwise.

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
| `profiles` | one per auth user; `role` = `customer` \| `driver`; created by a trigger from sign-up metadata |
| `tankers` | one per driver: plate, `service_type` (DW/WW/TE), `capacity_gal`, `is_online`, last GPS fix |
| `orders` | **`order_no`** (shown as `TO-<order_no>`), service, gallons, **area**, price lines (`numeric(10,3)` OMR), status, driver name and plate snapshot, per-status timestamps |
| `order_locations` | the **exact** lat/lng and address, kept apart so RLS can hide it until a driver accepts |

Order numbers (`0002_order_no.sql`) come from the `orders_order_no_seq` sequence, starting at 48200. A trigger assigns the next number on every insert and ignores any value supplied, and another rejects changes. Clients have no access to the sequence, and the column is `NOT NULL` and `UNIQUE`. Orders that existed before the migration were numbered in `created_at` order.

Status: `requested → accepted → arriving → arrived → delivered`, or `requested → cancelled`. `arriving` is set automatically by the driver's first GPS ping after accepting.

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
- **Customer:** Postgres Changes on its order row (status) and on the assigned tanker row (position). The tanker marker glides between 10 s fixes.
- **Driver:** Postgres Changes `INSERT` on `orders` for new requests, plus updates on its own job.
- **Gap filler:** once a request is accepted or cancelled, RLS hides it from other drivers, so they never receive that UPDATE. The accepting driver and the cancelling customer send a Broadcast `gone` message on the `open-requests` channel, and the list also refreshes every 15 s. Broadcast is only a UI hint. Correctness comes from the atomic accept.
- If you enable **Realtime → Settings → "Private channels only"**, the `open-requests` broadcast stops working (the 15 s refresh still runs). Either leave public channels on, or add a `realtime.messages` policy for authenticated users.

## Tests
```bash
npm run test:db
```
Runs the migrations in [PGlite](https://pglite.dev) (Postgres in WASM) against a stub of Supabase's `auth` schema and roles. It checks RLS for each role, every RPC and transition, the one-active-job index, the "already taken" path, JS/SQL price parity, and order numbers: the backfill order, uniqueness, that customers and drivers can't set or change them, and that the RPCs return them. Concurrency is exercised sequentially there. The race guarantee comes from Postgres row locking on the conditional `UPDATE`.

`npm run lint` and `npm run build` should both be clean.

## Project layout
```
app/
  login, signup, auth/callback      email + password auth; role chosen at sign-up
  onboarding/                       driver: plate, type, capacity
  customer/                         map picker + quote + place request
  customer/orders/[id]/             live status, driver card, moving tanker
  driver/                           online toggle, requests, active job + GPS
components/                         MapView (MapLibre), order UI, shell
lib/                                pricing, Supabase clients, types, geo, error copy
proxy.ts                            session refresh + optimistic redirects (Next 16 "proxy")
supabase/migrations/0001_init.sql   schema, RLS, RPCs, realtime publication
supabase/migrations/0002_order_no.sql  sequential order numbers (TO-48200…)
scripts/apply-migration.mjs         npm run db:apply: ordered, tracked migrations
supabase/tests/db.test.ts           PGlite test suite
scripts/seed.ts                     test customer + driver (service-role key)
```

## Known limits (MVP)
- No payments, ratings, push notifications, scheduling or admin screens. Customers can cancel only before acceptance.
- `open_requests_near` uses straight-line (haversine) distance, not road distance. Distances are rounded to 0.1 km.
- Tiles come from `tile.openstreetmap.org`, and the area name is suggested by OSM Nominatim from the customer's browser (the pin's coordinates are sent to it). Both are fine for development under their usage policies. For production, use a tile and geocoding provider.
- GPS pings run in the foreground tab. A production driver app needs a native wrapper for background location.
