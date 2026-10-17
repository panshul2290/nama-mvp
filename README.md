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

2. **Create the database.** In the Supabase dashboard open **SQL Editor**, paste `supabase/migrations/0001_init.sql`, and run it. Or, with the Supabase CLI:
   ```bash
   supabase link --project-ref YOUR-PROJECT-REF
   supabase db push
   ```

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
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server (anon or publishable key; RLS protects the data) |
   | `NEXT_PUBLIC_ENABLE_SIMULATION` | `true` shows the driver's *Simulate drive* switch (dev only) |
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
5. **Driver:** with *Simulate drive* ticked, the tanker moves toward the pin every 10 s. Tap **Mark arrived**, then **Mark delivered**.

To see the race handling, open the driver screen in two browsers (a second driver needs their own account; sign up as Driver and register a DW tanker). Accept the same request in both. One wins, and the other gets **"Already taken"**.

Geolocation needs a secure context. `localhost` works. To test on a phone over your LAN, run `npx next dev --experimental-https`.

## How it works

### Data model (`supabase/migrations/0001_init.sql`)
| Table | Purpose |
|---|---|
| `profiles` | one per auth user; `role` = `customer` \| `driver`; created by a trigger from sign-up metadata |
| `tankers` | one per driver: plate, `service_type` (DW/WW/TE), `capacity_gal`, `is_online`, last GPS fix |
| `orders` | service, gallons, **area**, price lines (`numeric(10,3)` OMR), status, driver name and plate snapshot, per-status timestamps |
| `order_locations` | the **exact** lat/lng and address, kept apart so RLS can hide it until a driver accepts |

Status: `requested → accepted → arriving → arrived → delivered`, or `requested → cancelled`. `arriving` is set automatically by the driver's first GPS ping after accepting.

### Pricing
| | Water | Delivery fee |
|---|---|---|
| DW | 1 baisa/gal for the first 650 gal, 3 baisa/gal above (tiered) | 3.500 OMR |
| WW | 1 baisa/gal | 6.000 OMR |
| TE | 0.05 baisa/gal | 8.000 OMR |

VAT is 5% of (water + fee). The driver earns 85% of the delivery fee. Each line is rounded to 3 decimals (1 OMR = 1000 baisa).
The price is computed **on the server** by `price_quote()` inside `place_order()`. `lib/pricing.ts` mirrors it only for the live quote, and the test suite checks the two agree.

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
Runs the migration in [PGlite](https://pglite.dev) (Postgres in WASM) against a stub of Supabase's `auth` schema and roles. It checks RLS for each role, every RPC and transition, the one-active-job index, the "already taken" path, and JS/SQL price parity. Concurrency is exercised sequentially there. The race guarantee comes from Postgres row locking on the conditional `UPDATE`.

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
supabase/tests/db.test.ts           PGlite test suite
scripts/seed.ts                     test customer + driver (service-role key)
```

## Known limits (MVP)
- No payments, ratings, push notifications, scheduling or admin screens. Customers can cancel only before acceptance.
- `open_requests_near` uses straight-line (haversine) distance, not road distance. Distances are rounded to 0.1 km.
- Tiles come from `tile.openstreetmap.org`, and the area name is suggested by OSM Nominatim from the customer's browser (the pin's coordinates are sent to it). Both are fine for development under their usage policies. For production, use a tile and geocoding provider.
- GPS pings run in the foreground tab. A production driver app needs a native wrapper for background location.
