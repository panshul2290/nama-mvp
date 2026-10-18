# Test report — database authorization, concurrency and GPS freshness

| | |
|---|---|
| Generated | 2026-10-18T08:56:54.420Z (UTC) |
| Git commit | `4e54be87a8feb22e124d3b2fbc95415946f23481` |
| Node.js | v24.16.0 on win32 |
| PGlite | 0.5.10 (Postgres compiled to WASM, single connection) |
| Supabase | project region `ap-northeast-1`, Postgres 17.11, reached through the Supavisor transaction pooler |
| Command | `npm run evidence` (runs `supabase/tests/run.ts` against each target) |

## Summary

| Target | Started | Passed | Failed | Skipped | Exit |
|---|---|---|---|---|---|
| pglite | 2026-10-18T08:49:17.249Z | 366 | 0 | 5 | 0 |
| supabase | 2026-10-18T08:49:24.771Z | 372 | 0 | 2 | 0 |

Raw output: [raw/pglite.txt](raw/pglite.txt), [raw/supabase.txt](raw/supabase.txt) (and the matching `.json`).

## How the two runs differ

- **PGlite** builds a fresh database from `supabase/migrations/*.sql` on a stub of Supabase's `auth` schema and roles. It has one connection, so the race tests run serialised there: that checks the logic, not concurrency.
- **Supabase** runs the same suites against the live project. Every user is created as `test-<run id>-…@nama.test` through the Auth admin API, with test-prefixed tanker plates and order areas. All of them are deleted at the end, and their rows go with them via foreign-key cascades. The run fingerprints every non-test user and row (md5 over profiles, tankers, orders, order_locations) before and after, and fails if anything changed. Checks that need a global change run in transactions that are rolled back.
- **Race tests on Supabase:** each driver has its own Postgres backend, and all are held at an advisory-lock barrier inside their transaction, then released together. The output records how many were blocked at the barrier when it opened. The pooler limits how many transactions can hold a server connection at the same moment.
- **Side effect:** the order-number sequence advances during the Supabase run (test orders consume numbers), so real order numbers skip ahead. No real row is changed.

## Results

### MIG migrations and schema

| ID | Check | PGlite | Supabase |
|---|---|---|---|
| MIG-01 | orders that existed before 0002 were numbered 48200… in created_at order | PASS | — |
| MIG-02 | migrations recorded in supabase_migrations.schema_migrations | SKIP (PGlite applies files directly; tracking is checked on Supabase) | — |
| MIG-03 | orders.order_no is NOT NULL, UNIQUE, with assign + freeze triggers | PASS | PASS |
| MIG-04 | read-only scan: every order has a number and none repeat | PASS | PASS |
| MIG-05 | RLS is enabled on profiles, tankers, orders, order_locations | PASS | PASS |
| MIG-06 | orders and tankers are in the supabase_realtime publication | PASS | PASS |
| MIG-07 | no RPC is executable by anon; all are executable by signed-in users | PASS | PASS |
| MIG-08 | the order-number sequence is not usable by anon or signed-in users | PASS | PASS |
| MIG-01 | backfill order of pre-0002 orders | — | SKIP (needs a pre-0002 database; checked on the fresh PGlite build) |
| MIG-02 | every migration file is recorded as applied (0001, 0002, 0003, 0004, 0005, 0006, 0007, 0008) | — | PASS |

### PRICE pricing

| ID | Check | PGlite | Supabase |
|---|---|---|---|
| PRICE-01 | price_quote DW 650 gal = 4.358 OMR (water/fee/VAT/total/earnings) | PASS | PASS |
| PRICE-02 | price_quote DW 1000 gal = 5.460 OMR (water/fee/VAT/total/earnings) | PASS | PASS |
| PRICE-03 | price_quote DW 3000 gal = 11.760 OMR (water/fee/VAT/total/earnings) | PASS | PASS |
| PRICE-04 | price_quote WW 3000 gal = 9.450 OMR (water/fee/VAT/total/earnings) | PASS | PASS |
| PRICE-05 | price_quote TE 10000 gal = 8.925 OMR (water/fee/VAT/total/earnings) | PASS | PASS |
| PRICE-06 | lib/pricing.ts reproduces price_quote() amounts and line statuses from the rules table (63 type/volume pairs) | PASS | PASS |

### LIFE order lifecycle

| ID | Check | PGlite | Supabase |
|---|---|---|---|
| LIFE-01 | place_order prices on the server (DW 1,000 gal = 5.460) and starts as requested | PASS | PASS |
| LIFE-02 | the order gets an order_no ≥ 48200 | PASS | PASS |
| LIFE-03 | offline driver sees no requests | PASS | PASS |
| LIFE-04 | online matching driver sees the request | PASS | PASS |
| LIFE-05 | driver of another service type does not | PASS | PASS |
| LIFE-06 | capacity filter: 3,000-gal tanker doesn't see a 4,000-gal request; 5,000-gal tanker does | PASS | PASS |
| LIFE-07 | ineligible driver accepting it → not_eligible | PASS | PASS |
| LIFE-08 | first driver accepts; plate and name are snapshotted on the order | PASS | PASS |
| LIFE-09 | second driver → already_taken | PASS | PASS |
| LIFE-10 | busy driver cannot take a second job → driver_busy | PASS | PASS |
| LIFE-11 | customer cannot cancel once accepted → cannot_cancel | PASS | PASS |
| LIFE-12 | first GPS ping moves the job to arriving | PASS | PASS |
| LIFE-13 | arrived → delivered | PASS | PASS |
| LIFE-14 | customer keeps the plate snapshot after delivery | PASS | PASS |
| LIFE-15 | driver is free for the next job after delivery | PASS | PASS |
| LIFE-16 | customer cancels an open request | PASS | PASS |
| LIFE-17 | a cancelled request can't be accepted → already_taken | PASS | PASS |

### ONUM order numbers

| ID | Check | PGlite | Supabase |
|---|---|---|---|
| ONUM-01 | 25 orders in a row get 25 distinct, increasing numbers | PASS | PASS |
| ONUM-02 | no two orders in the database share a number | PASS | PASS |
| ONUM-03 | a number supplied on insert is ignored, even by a privileged role (no duplicate possible) | PASS | PASS |
| ONUM-04 | customer cannot change an order_no | PASS | PASS |
| ONUM-05 | customer cannot call nextval on the sequence | PASS | PASS |
| ONUM-06 | customer cannot setval the sequence | PASS | PASS |
| ONUM-07 | driver cannot change an order_no | PASS | PASS |
| ONUM-08 | driver cannot call nextval on the sequence | PASS | PASS |
| ONUM-09 | driver cannot setval the sequence | PASS | PASS |
| ONUM-10 | order_no is frozen even for privileged updates | PASS | PASS |
| ONUM-11 | RPCs return order_no (cancel_order) | PASS | PASS |
| ONUM-12 | RPCs return order_no (open_requests_near) | PASS | PASS |

### RULES pricing rules and billing mode

| ID | Check | PGlite | Supabase |
|---|---|---|---|
| RULES-01 | confirmed (tender tariff table): DW ≤650 gal 1 baisa, WW 1 baisa, TE 0.05 baisa (+ the 650 gal threshold) | PASS | PASS |
| RULES-02 | pending clarification: DW >650 gal basis (Q05: slab vs whole volume) and VAT application (Q07) | PASS | PASS |
| RULES-03 | assumptions: base fees DW 3.5 / WW 6 / TE 8, driver share 0.85, peak 1.2, priority 1.5, monthly 0.10, yearly 0.15, cancel fee 1 | PASS | PASS |
| RULES-04 | BILLING_MODE defaults to demo | PASS | PASS |
| RULES-05 | demo: DW 600 gal is priced; water confirmed, fee assumption, VAT pending, total pending, earnings assumption | PASS | PASS |
| RULES-06 | demo: DW 3,000 gal (slab) = 11.760 and its water line is pending (Q05) | PASS | PASS |
| RULES-07 | demo: WW 3,000 gal water line is confirmed | PASS | PASS |
| RULES-08 | driver's open-request list reports the earnings status (assumption) | PASS | PASS |
| RULES-09 | changing a rule changes the price (fee_dw_omr 3.5 → 4: DW 600 = 4.830) | PASS | PASS |
| RULES-10 | switching Q05 to whole_volume prices DW 3,000 gal water at 9.000 (3 baisa on every gallon) | PASS | PASS |
| RULES-11 | a price supplied on insert is replaced by the rules, even for a privileged role | PASS | PASS |
| RULES-12 | prices are frozen after insert (privileged update → price_immutable) | PASS | PASS |
| RULES-13 | production: an order using unconfirmed rules is refused with a clear error | PASS | PASS |
| RULES-14 | production: the error also names the Q05 rules for DW above 650 gal | PASS | PASS |
| RULES-15 | production: the trigger also refuses a privileged direct insert | PASS | PASS |
| RULES-16 | production: once every rule the order uses is confirmed, it is priced (DW 600 gal) | PASS | PASS |
| RULES-17 | production: DW 3,000 gal is still refused while Q05 is pending — and only the Q05 rules are listed | PASS | PASS |
| RULES-18 | BILLING_MODE only accepts demo or production | PASS | PASS |
| RULES-19 | after the production-mode checks, BILLING_MODE and rule statuses are back as they were (rolled back) | PASS | PASS |
| RULES-20 | anon cannot read pricing_rules | PASS | PASS |
| RULES-21 | signed-in users can read pricing_rules (for the quote screen) | PASS | PASS |
| RULES-22 | customer cannot change a pricing rule | PASS | PASS |
| RULES-23 | customer cannot mark a rule confirmed | PASS | PASS |
| RULES-24 | customer cannot add a pricing rule | PASS | PASS |
| RULES-25 | customer cannot change BILLING_MODE | PASS | PASS |
| RULES-26 | driver cannot change a pricing rule | PASS | PASS |
| RULES-27 | driver cannot mark a rule confirmed | PASS | PASS |
| RULES-28 | driver cannot add a pricing rule | PASS | PASS |
| RULES-29 | driver cannot change BILLING_MODE | PASS | PASS |

### AUTHZ authorization matrix

| ID | Check | PGlite | Supabase |
|---|---|---|---|
| AUTHZ-01 | anon cannot SELECT profiles | PASS | PASS |
| AUTHZ-02 | anon cannot SELECT tankers | PASS | PASS |
| AUTHZ-03 | anon cannot SELECT orders | PASS | PASS |
| AUTHZ-04 | anon cannot SELECT order_locations | PASS | PASS |
| AUTHZ-05 | anon cannot INSERT orders | PASS | PASS |
| AUTHZ-06 | anon cannot call place_order() | PASS | PASS |
| AUTHZ-07 | anon cannot call cancel_order() | PASS | PASS |
| AUTHZ-08 | anon cannot call open_requests_near() | PASS | PASS |
| AUTHZ-09 | anon cannot call accept_order() | PASS | PASS |
| AUTHZ-10 | anon cannot call report_location() | PASS | PASS |
| AUTHZ-11 | anon cannot call mark_arrived() | PASS | PASS |
| AUTHZ-12 | anon cannot call mark_delivered() | PASS | PASS |
| AUTHZ-13 | anon cannot call price_quote() | PASS | PASS |
| AUTHZ-14 | customer reads own profile | PASS | PASS |
| AUTHZ-15 | customer cannot read other customer's profile (0 rows) | PASS | PASS |
| AUTHZ-16 | customer cannot read the driver's profile (0 rows; name comes from the order snapshot) | PASS | PASS |
| AUTHZ-17 | driver reads the customer on their active job | PASS | PASS |
| AUTHZ-18 | other driver cannot read that customer (0 rows) | PASS | PASS |
| AUTHZ-19 | customer updates own full_name | PASS | PASS |
| AUTHZ-20 | customer cannot update another profile (0 rows) | PASS | PASS |
| AUTHZ-21 | customer cannot change own role | PASS | PASS |
| AUTHZ-22 | customer cannot INSERT a profile | PASS | PASS |
| AUTHZ-23 | other customer cannot change own role | PASS | PASS |
| AUTHZ-24 | other customer cannot INSERT a profile | PASS | PASS |
| AUTHZ-25 | driver cannot change own role | PASS | PASS |
| AUTHZ-26 | driver cannot INSERT a profile | PASS | PASS |
| AUTHZ-27 | other driver cannot change own role | PASS | PASS |
| AUTHZ-28 | other driver cannot INSERT a profile | PASS | PASS |
| AUTHZ-29 | customer reads the tanker on their active order (with location columns) | PASS | PASS |
| AUTHZ-30 | customer cannot read a tanker not on their active order (0 rows) | PASS | PASS |
| AUTHZ-31 | other customer cannot read the assigned tanker's location (0 rows) | PASS | PASS |
| AUTHZ-32 | driver reads the tanker assigned to them | PASS | PASS |
| AUTHZ-33 | driver cannot read another driver's tanker (0 rows) | PASS | PASS |
| AUTHZ-34 | driver reads own active assignment | PASS | PASS |
| AUTHZ-35 | driver sees only their own assignment rows | PASS | PASS |
| AUTHZ-36 | driver goes online through driver_set_online() | PASS | PASS |
| AUTHZ-37 | driver cannot UPDATE tankers SET is_online = false directly | PASS | PASS |
| AUTHZ-38 | driver cannot UPDATE tankers SET last_lat = 1 directly | PASS | PASS |
| AUTHZ-39 | driver cannot UPDATE tankers SET last_lng = 1 directly | PASS | PASS |
| AUTHZ-40 | driver cannot UPDATE tankers SET last_seen_at = now() directly | PASS | PASS |
| AUTHZ-41 | driver cannot UPDATE tankers SET blocked = false directly | PASS | PASS |
| AUTHZ-42 | driver cannot UPDATE tankers SET plate = 'X' directly | PASS | PASS |
| AUTHZ-43 | driver cannot INSERT a tanker directly | PASS | PASS |
| AUTHZ-44 | driver cannot write tanker_assignments directly | PASS | PASS |
| AUTHZ-45 | customer cannot register a tanker (driver_register_tanker → not_a_driver) | PASS | PASS |
| AUTHZ-46 | customer cannot INSERT a tanker directly | PASS | PASS |
| AUTHZ-47 | customer cannot go online (driver_set_online → not_a_driver) | PASS | PASS |
| AUTHZ-48 | customer reads own orders | PASS | PASS |
| AUTHZ-49 | customer cannot read another customer's order (0 rows) | PASS | PASS |
| AUTHZ-50 | other customer cannot read C1's orders (0 rows) | PASS | PASS |
| AUTHZ-51 | driver sees an open request row (no address columns exist on orders) | PASS | PASS |
| AUTHZ-52 | driver sees own accepted job | PASS | PASS |
| AUTHZ-53 | other driver cannot see someone else's accepted job (0 rows) | PASS | PASS |
| AUTHZ-54 | customers see no open requests of others (0 rows) | PASS | PASS |
| AUTHZ-55 | anon cannot UPDATE orders SET total = 0 | PASS | PASS |
| AUTHZ-56 | anon cannot UPDATE orders SET water_charge = 0 | PASS | PASS |
| AUTHZ-57 | anon cannot UPDATE orders SET delivery_fee = 0 | PASS | PASS |
| AUTHZ-58 | anon cannot UPDATE orders SET vat = 0 | PASS | PASS |
| AUTHZ-59 | anon cannot UPDATE orders SET driver_earnings = 99 | PASS | PASS |
| AUTHZ-60 | anon cannot UPDATE orders SET order_no = 1 | PASS | PASS |
| AUTHZ-61 | anon cannot UPDATE orders SET status = 'delivered' | PASS | PASS |
| AUTHZ-62 | anon cannot UPDATE orders SET driver_id = null | PASS | PASS |
| AUTHZ-63 | customer cannot UPDATE orders SET total = 0 | PASS | PASS |
| AUTHZ-64 | customer cannot UPDATE orders SET water_charge = 0 | PASS | PASS |
| AUTHZ-65 | customer cannot UPDATE orders SET delivery_fee = 0 | PASS | PASS |
| AUTHZ-66 | customer cannot UPDATE orders SET vat = 0 | PASS | PASS |
| AUTHZ-67 | customer cannot UPDATE orders SET driver_earnings = 99 | PASS | PASS |
| AUTHZ-68 | customer cannot UPDATE orders SET order_no = 1 | PASS | PASS |
| AUTHZ-69 | customer cannot UPDATE orders SET status = 'delivered' | PASS | PASS |
| AUTHZ-70 | customer cannot UPDATE orders SET driver_id = null | PASS | PASS |
| AUTHZ-71 | customer cannot INSERT an order with its own price/status/number | PASS | PASS |
| AUTHZ-72 | customer cannot DELETE orders | PASS | PASS |
| AUTHZ-73 | other customer cannot UPDATE orders SET total = 0 | PASS | PASS |
| AUTHZ-74 | other customer cannot UPDATE orders SET water_charge = 0 | PASS | PASS |
| AUTHZ-75 | other customer cannot UPDATE orders SET delivery_fee = 0 | PASS | PASS |
| AUTHZ-76 | other customer cannot UPDATE orders SET vat = 0 | PASS | PASS |
| AUTHZ-77 | other customer cannot UPDATE orders SET driver_earnings = 99 | PASS | PASS |
| AUTHZ-78 | other customer cannot UPDATE orders SET order_no = 1 | PASS | PASS |
| AUTHZ-79 | other customer cannot UPDATE orders SET status = 'delivered' | PASS | PASS |
| AUTHZ-80 | other customer cannot UPDATE orders SET driver_id = null | PASS | PASS |
| AUTHZ-81 | other customer cannot INSERT an order with its own price/status/number | PASS | PASS |
| AUTHZ-82 | other customer cannot DELETE orders | PASS | PASS |
| AUTHZ-83 | driver cannot UPDATE orders SET total = 0 | PASS | PASS |
| AUTHZ-84 | driver cannot UPDATE orders SET water_charge = 0 | PASS | PASS |
| AUTHZ-85 | driver cannot UPDATE orders SET delivery_fee = 0 | PASS | PASS |
| AUTHZ-86 | driver cannot UPDATE orders SET vat = 0 | PASS | PASS |
| AUTHZ-87 | driver cannot UPDATE orders SET driver_earnings = 99 | PASS | PASS |
| AUTHZ-88 | driver cannot UPDATE orders SET order_no = 1 | PASS | PASS |
| AUTHZ-89 | driver cannot UPDATE orders SET status = 'delivered' | PASS | PASS |
| AUTHZ-90 | driver cannot UPDATE orders SET driver_id = null | PASS | PASS |
| AUTHZ-91 | driver cannot INSERT an order with its own price/status/number | PASS | PASS |
| AUTHZ-92 | driver cannot DELETE orders | PASS | PASS |
| AUTHZ-93 | other driver cannot UPDATE orders SET total = 0 | PASS | PASS |
| AUTHZ-94 | other driver cannot UPDATE orders SET water_charge = 0 | PASS | PASS |
| AUTHZ-95 | other driver cannot UPDATE orders SET delivery_fee = 0 | PASS | PASS |
| AUTHZ-96 | other driver cannot UPDATE orders SET vat = 0 | PASS | PASS |
| AUTHZ-97 | other driver cannot UPDATE orders SET driver_earnings = 99 | PASS | PASS |
| AUTHZ-98 | other driver cannot UPDATE orders SET order_no = 1 | PASS | PASS |
| AUTHZ-99 | other driver cannot UPDATE orders SET status = 'delivered' | PASS | PASS |
| AUTHZ-100 | other driver cannot UPDATE orders SET driver_id = null | PASS | PASS |
| AUTHZ-101 | other driver cannot INSERT an order with its own price/status/number | PASS | PASS |
| AUTHZ-102 | other driver cannot DELETE orders | PASS | PASS |
| AUTHZ-103 | customer reads own exact location | PASS | PASS |
| AUTHZ-104 | other customer cannot read it (0 rows) | PASS | PASS |
| AUTHZ-105 | driver cannot see the exact address before acceptance (0 rows) | PASS | PASS |
| AUTHZ-106 | driver cannot see it via the request they could accept either (D1, 0 rows) | PASS | PASS |
| AUTHZ-107 | assigned driver sees the exact address after acceptance | PASS | PASS |
| AUTHZ-108 | other driver cannot see the accepted job's address (0 rows) | PASS | PASS |
| AUTHZ-109 | anon cannot UPDATE order_locations | PASS | PASS |
| AUTHZ-110 | customer cannot UPDATE order_locations | PASS | PASS |
| AUTHZ-111 | other customer cannot UPDATE order_locations | PASS | PASS |
| AUTHZ-112 | driver cannot UPDATE order_locations | PASS | PASS |
| AUTHZ-113 | other driver cannot UPDATE order_locations | PASS | PASS |
| AUTHZ-114 | driver: open_requests_near returns the request without coordinates or address | PASS | PASS |
| AUTHZ-115 | customer: open_requests_near → not_a_driver | PASS | PASS |
| AUTHZ-116 | driver: place_order → not_a_customer | PASS | PASS |
| AUTHZ-117 | customer: accept_order → not_a_driver | PASS | PASS |
| AUTHZ-118 | busy driver: accept_order → driver_busy | PASS | PASS |
| AUTHZ-119 | other driver: accept an already accepted order → already_taken | PASS | PASS |
| AUTHZ-120 | other customer: cancel C1's request → not_found | PASS | PASS |
| AUTHZ-121 | driver: cancel_order → not_found | PASS | PASS |
| AUTHZ-122 | customer: cancel an accepted order → cannot_cancel | PASS | PASS |
| AUTHZ-123 | customer: report_location → not_a_driver | PASS | PASS |
| AUTHZ-124 | customer: mark_arrived → invalid_transition | PASS | PASS |
| AUTHZ-125 | other driver: mark_arrived on someone else's job → invalid_transition | PASS | PASS |
| AUTHZ-126 | assigned driver: mark_delivered before arrived → invalid_transition | PASS | PASS |
| AUTHZ-127 | assigned driver: report_location | PASS | PASS |
| AUTHZ-128 | assigned driver: mark_arrived | PASS | PASS |
| AUTHZ-129 | other driver: mark_delivered → invalid_transition | PASS | PASS |
| AUTHZ-130 | assigned driver: mark_delivered | PASS | PASS |
| AUTHZ-131 | customer: cancel own open request | PASS | PASS |
| AUTHZ-132 | signed-in user: price_quote | PASS | PASS |
| AUTHZ-133 | after delivery, customer can no longer read the tanker (0 rows) | PASS | PASS |
| AUTHZ-134 | after delivery, driver can no longer read the exact address (0 rows) | PASS | PASS |
| AUTHZ-135 | after delivery, driver can no longer read the customer's profile (0 rows) | PASS | PASS |

### RACE concurrency

| ID | Check | PGlite | Supabase |
|---|---|---|---|
| RACE-01 | 20 drivers call accept_order on the same order at once: exactly 1 succeeds | PASS — serialised on PGlite's single connection — logic only, not a race | PASS — concurrent (separate backends, released from a barrier); 15 of 20 were blocked at the barrier when it opened |
| RACE-02 | … and the other 19 get already_taken | PASS — serialised on PGlite's single connection — logic only, not a race | PASS — concurrent (separate backends, released from a barrier); 15 of 20 were blocked at the barrier when it opened |
| RACE-03 | the order row is accepted and belongs to the single winner | PASS | PASS |
| RACE-04 | one driver accepts two orders at once (5 rounds): always exactly one active job; the other call gets driver_busy | PASS — serialised on PGlite's single connection — logic only, not a race; per round: [{"round":0,"active":1,"ok":1,"busy":1,"waiting":0},{"round":1,"active":1,"ok":1,"busy":1,"waiting":0},{"round":2,"active":1,"ok":1,"busy":1," | PASS — concurrent (separate backends, released from a barrier); per round: [{"round":0,"active":1,"ok":1,"busy":1,"waiting":2},{"round":1,"active":1,"ok":1,"busy":1,"waiting":2},{"round":2,"active":1,"ok":1,"busy":1,"waiting":2 |

### GPS location freshness

| ID | Check | PGlite | Supabase |
|---|---|---|---|
| GPS-01 | before any fix: no timestamp and reported stale | PASS | PASS |
| GPS-02 | report_location stores the fix with a server timestamp (within 5 s of now) | PASS | PASS |
| GPS-03 | a fresh fix is not stale | PASS | PASS |
| GPS-04 | fix 55 s old → stale = false | PASS | PASS |
| GPS-05 | fix 65 s old → stale = true | PASS | PASS |
| GPS-06 | fix 600 s old → stale = true | PASS | PASS |
| GPS-07 | the driver sees the same staleness on their own tanker | PASS | PASS |
| GPS-08 | another customer gets no row (RLS), so no location or freshness leaks | PASS | PASS |
| GPS-09 | anon cannot call location_stale() | PASS | PASS |
| GPS-10 | a new fix clears the stale flag | PASS | PASS |
| GPS-11 | a fix with accuracy 100 m is accepted | PASS | PASS |
| GPS-12 | the fix's accuracy (m) and device timestamp are stored | PASS | PASS |
| GPS-13 | a fix with accuracy worse than 100 m is rejected | PASS | PASS |
| GPS-14 | a fix without accuracy is rejected | PASS | PASS |
| GPS-15 | a fix timestamped more than 2 min ago is rejected | PASS | PASS |
| GPS-16 | a fix timestamped more than 5 min in the future is rejected | PASS | PASS |
| GPS-17 | an out-of-order (older) fix is ignored | PASS | PASS |
| GPS-18 | rejected fixes never changed the stored position | PASS | PASS |
| GPS-19 | REST API returns location_stale | SKIP (PGlite has no PostgREST; covered by the Supabase run) | — |
| GPS-19 | REST API (as the customer): tankers?select=…,location_stale returns stale = true for a 61 s old fix | — | PASS |
| GPS-20 | REST API (as another customer): no row returned | — | PASS |

### PRIV location privacy

| ID | Check | PGlite | Supabase |
|---|---|---|---|
| PRIV-01 | a customer cannot report a live location (report_location → not_a_driver) | PASS | PASS |
| PRIV-02 | no table lets a signed-in user (or anon) write a coordinate column directly | PASS | PASS |
| PRIV-03 | a customer cannot create a tanker row (the only table holding live positions) | PASS | PASS |
| PRIV-04 | a customer cannot write order_locations directly | PASS | PASS |
| PRIV-05 | customer screens never send their position (source check) | SKIP (covered by npm run test:unit (tests/unit/privacy.test.ts)) | SKIP (covered by npm run test:unit (tests/unit/privacy.test.ts)) |
| PRIV-06 | open request: the customer cannot see any driver's location yet | PASS | PASS |
| PRIV-07 | accepted: the order's customer sees the driver's location | PASS | PASS |
| PRIV-08 | accepted: another customer does not | PASS | PASS |
| PRIV-09 | accepted: another driver does not | PASS | PASS |
| PRIV-10 | accepted: anon does not | PASS | PASS |
| PRIV-11 | arrived: the order's customer still sees it | PASS | PASS |
| PRIV-12 | Realtime: only the active order's customer receives location updates | SKIP (PGlite has no Realtime server; covered by the Supabase run) | — |
| PRIV-14 | delivered: the customer can no longer see the driver's location | PASS | PASS |
| PRIV-14 | Realtime: no updates after delivery | SKIP (covered by the Supabase run) | — |
| PRIV-16 | cancelled request: the customer sees no driver location | PASS | PASS |
| PRIV-17 | accepted (second order): its customer sees the driver | PASS | PASS |
| PRIV-18 | accepted order cancelled (operator action): the customer can no longer see the driver | PASS | PASS |
| PRIV-19 | … and the previous customer still can't either | PASS | PASS |
| PRIV-12 | Realtime: the active order's customer receives the driver's location updates | — | PASS |
| PRIV-13 | Realtime: another customer subscribed to the same driver receives nothing | — | PASS |
| PRIV-15 | Realtime: after delivery, the customer receives no further location updates | — | PASS |

### ASSIGN tankers and driver assignments

| ID | Check | PGlite | Supabase |
|---|---|---|---|
| ASSIGN-01 | a driver with a tanker can't register a second one (already_assigned) | PASS | PASS |
| ASSIGN-02 | the database refuses a second active assignment for a driver (unique index) | PASS | PASS |
| ASSIGN-03 | the database refuses a second active assignment for a tanker (unique index) | PASS | PASS |
| ASSIGN-04 | registering a plate that already exists → plate_taken | PASS | PASS |
| ASSIGN-05 | a driver without a tanker can't go online (no_tanker) | PASS | PASS |
| ASSIGN-06 | a driver without a tanker can't see open requests (no_tanker) | PASS | PASS |
| ASSIGN-07 | a driver without a tanker can't report a location (no_tanker) | PASS | PASS |
| ASSIGN-08 | a driver without a tanker can't accept (no_tanker) | PASS | PASS |
| ASSIGN-09 | a driver without a tanker sees no tanker rows | PASS | PASS |
| ASSIGN-10 | accept_order records both driver and tanker on the order | PASS | PASS |
| ASSIGN-11 | the database refuses a second active job for the same tanker (unique index) | PASS | PASS |
| ASSIGN-12 | after reassignment the new driver sees the same tanker with its last GPS fix | PASS | PASS |
| ASSIGN-13 | the previous driver no longer sees the tanker | PASS | PASS |
| ASSIGN-14 | the previous driver can no longer report locations for it (no_tanker) | PASS | PASS |
| ASSIGN-15 | the tanker's permit carries over: the new driver can go online | PASS | PASS |
| ASSIGN-16 | the new driver's fixes update the same tanker row | PASS | PASS |
| ASSIGN-17 | assignment history is kept (old row closed, new row active) | PASS | PASS |
| ASSIGN-18 | a new tanker without a permit can't go online (permit_invalid) | PASS | PASS |

### STAFF NWS staff portal

| ID | Check | PGlite | Supabase |
|---|---|---|---|
| STAFF-01 | signing up with role nws_staff produces a customer (no staff_role) | PASS | PASS |
| STAFF-02 | a user can't make themselves staff by updating their profile | PASS | PASS |
| STAFF-03 | anon → staff_block_tanker: refused | PASS | PASS |
| STAFF-04 | customer → staff_block_tanker: refused | PASS | PASS |
| STAFF-05 | driver → staff_block_tanker: refused | PASS | PASS |
| STAFF-06 | anon → staff_unblock_tanker: refused | PASS | PASS |
| STAFF-07 | customer → staff_unblock_tanker: refused | PASS | PASS |
| STAFF-08 | driver → staff_unblock_tanker: refused | PASS | PASS |
| STAFF-09 | anon → staff_assign_tanker: refused | PASS | PASS |
| STAFF-10 | customer → staff_assign_tanker: refused | PASS | PASS |
| STAFF-11 | driver → staff_assign_tanker: refused | PASS | PASS |
| STAFF-12 | anon → staff_unassign_tanker: refused | PASS | PASS |
| STAFF-13 | customer → staff_unassign_tanker: refused | PASS | PASS |
| STAFF-14 | driver → staff_unassign_tanker: refused | PASS | PASS |
| STAFF-15 | anon → staff_create_permit: refused | PASS | PASS |
| STAFF-16 | customer → staff_create_permit: refused | PASS | PASS |
| STAFF-17 | driver → staff_create_permit: refused | PASS | PASS |
| STAFF-18 | anon → staff_review_permit: refused | PASS | PASS |
| STAFF-19 | customer → staff_review_permit: refused | PASS | PASS |
| STAFF-20 | driver → staff_review_permit: refused | PASS | PASS |
| STAFF-21 | anon → staff_resubmit_permit: refused | PASS | PASS |
| STAFF-22 | customer → staff_resubmit_permit: refused | PASS | PASS |
| STAFF-23 | driver → staff_resubmit_permit: refused | PASS | PASS |
| STAFF-24 | anon → staff_set_role: refused | PASS | PASS |
| STAFF-25 | customer → staff_set_role: refused | PASS | PASS |
| STAFF-26 | driver → staff_set_role: refused | PASS | PASS |
| STAFF-27 | refused calls write no audit rows | PASS | PASS |
| STAFF-28 | anon can't read audit_log | PASS | PASS |
| STAFF-29 | customer sees no audit rows | PASS | PASS |
| STAFF-30 | driver sees no audit rows | PASS | PASS |
| STAFF-31 | operator → staff_create_permit: forbidden for this sub-role | PASS | PASS |
| STAFF-32 | operator → staff_review_permit: forbidden for this sub-role | PASS | PASS |
| STAFF-33 | operator → staff_resubmit_permit: forbidden for this sub-role | PASS | PASS |
| STAFF-34 | operator → staff_set_role: forbidden for this sub-role | PASS | PASS |
| STAFF-35 | permit_officer → staff_block_tanker: forbidden for this sub-role | PASS | PASS |
| STAFF-36 | permit_officer → staff_unblock_tanker: forbidden for this sub-role | PASS | PASS |
| STAFF-37 | permit_officer → staff_assign_tanker: forbidden for this sub-role | PASS | PASS |
| STAFF-38 | permit_officer → staff_unassign_tanker: forbidden for this sub-role | PASS | PASS |
| STAFF-39 | permit_officer → staff_set_role: forbidden for this sub-role | PASS | PASS |
| STAFF-40 | admin → staff_block_tanker: forbidden for this sub-role | PASS | PASS |
| STAFF-41 | admin → staff_unblock_tanker: forbidden for this sub-role | PASS | PASS |
| STAFF-42 | admin → staff_assign_tanker: forbidden for this sub-role | PASS | PASS |
| STAFF-43 | admin → staff_unassign_tanker: forbidden for this sub-role | PASS | PASS |
| STAFF-44 | admin → staff_create_permit: forbidden for this sub-role | PASS | PASS |
| STAFF-45 | admin → staff_review_permit: forbidden for this sub-role | PASS | PASS |
| STAFF-46 | admin → staff_resubmit_permit: forbidden for this sub-role | PASS | PASS |
| STAFF-47 | operator reads all orders, locations, tankers, assignments, permits and profiles | PASS | PASS |
| STAFF-48 | permit_officer reads all orders, locations, tankers, assignments, permits and profiles | PASS | PASS |
| STAFF-49 | admin reads all orders, locations, tankers, assignments, permits and profiles | PASS | PASS |
| STAFF-50 | admin can't change their own staff_role (cannot_change_own_role) | PASS | PASS |
| STAFF-51 | admin can't remove their own staff role either | PASS | PASS |
| STAFF-52 | admin can't edit their own role/staff_role columns directly | PASS | PASS |
| STAFF-53 | admin can't edit their own role column directly | PASS | PASS |
| STAFF-54 | staff_set_role requires a reason | PASS | PASS |
| STAFF-55 | staff_set_role can't turn a driver into staff | PASS | PASS |
| STAFF-56 | admin makes a user an operator | PASS | PASS |
| STAFF-57 | … exactly one audit row, with before/after and actor | PASS | PASS |
| STAFF-58 | admin removes the staff role again (back to customer), audited | PASS | PASS |
| STAFF-59 | block requires a reason | PASS | PASS |
| STAFF-60 | operator blocks a tanker; it is taken offline | PASS | PASS |
| STAFF-61 | … exactly one audit row (tanker.block, before online/unblocked → after offline/blocked) | PASS | PASS |
| STAFF-62 | a blocked tanker can't go online (tanker_blocked) | PASS | PASS |
| STAFF-63 | a blocked tanker can't accept (tanker_blocked) | PASS | PASS |
| STAFF-64 | a blocked tanker sees no open requests | PASS | PASS |
| STAFF-65 | blocking twice → already_blocked | PASS | PASS |
| STAFF-66 | … unblock writes exactly one more audit row | PASS | PASS |
| STAFF-67 | after unblocking, the tanker can go online again | PASS | PASS |
| STAFF-68 | unassigning a tanker on a job is refused (tanker_on_job) | PASS | PASS |
| STAFF-69 | operator unassigns the tanker (one audit row) | PASS | PASS |
| STAFF-70 | assigning a driver who already has a tanker → driver_already_assigned | PASS | PASS |
| STAFF-71 | assigning a tanker that already has a driver → tanker_already_assigned | PASS | PASS |
| STAFF-72 | operator assigns it back (one audit row) | PASS | PASS |
| STAFF-73 | two operators assign the same tanker at once: exactly one succeeds, one active assignment | PASS — serialised on PGlite | PASS — concurrent from a barrier |
| STAFF-74 | no permit: the tanker can't go online (permit_invalid) | PASS | PASS |
| STAFF-75 | permit officer creates a permit (pending) with one audit row | PASS | PASS |
| STAFF-76 | pending permit: still can't go online | PASS | PASS |
| STAFF-77 | rejecting needs a reason | PASS | PASS |
| STAFF-78 | reject: one audit row, before pending → after rejected, with reason | PASS | PASS |
| STAFF-79 | rejected permit: can't go online | PASS | PASS |
| STAFF-80 | a rejected permit can't be approved directly (invalid_state) | PASS | PASS |
| STAFF-81 | rejection allows resubmission (back to pending, one audit row) | PASS | PASS |
| STAFF-82 | resubmitted (pending) permit: still can't go online | PASS | PASS |
| STAFF-83 | approve: one audit row | PASS | PASS |
| STAFF-84 | approved, unexpired permit: the tanker can go online | PASS | PASS |
| STAFF-85 | expired permit: can't accept (permit_invalid), even while still online | PASS | PASS |
| STAFF-86 | expired permit: no open requests are shown | PASS | PASS |
| STAFF-87 | expired permit: can't go online | PASS | PASS |
| STAFF-88 | an approved permit past its expiry reads 'expired' | PASS | PASS |
| STAFF-89 | a permit for another service type doesn't count (permit_invalid) | PASS | PASS |
| STAFF-90 | operator can't UPDATE audit_log | PASS | PASS |
| STAFF-91 | operator can't DELETE from audit_log | PASS | PASS |
| STAFF-92 | operator can't INSERT into audit_log directly | PASS | PASS |
| STAFF-93 | admin can't UPDATE audit_log | PASS | PASS |
| STAFF-94 | admin can't DELETE from audit_log | PASS | PASS |
| STAFF-95 | admin can't INSERT into audit_log directly | PASS | PASS |
| STAFF-96 | customer can't UPDATE audit_log | PASS | PASS |
| STAFF-97 | customer can't DELETE from audit_log | PASS | PASS |
| STAFF-98 | customer can't INSERT into audit_log directly | PASS | PASS |
| STAFF-99 | the database owner can't UPDATE audit rows either (audit_log_append_only) | PASS | PASS |
| STAFF-100 | the database owner can't DELETE audit rows either (audit_log_append_only) | PASS | PASS |
| STAFF-101 | TRUNCATE audit_log is refused (audit_log_append_only) | PASS | PASS |
| STAFF-102 | the audit row is unchanged afterwards | PASS | PASS |
| STAFF-103 | a driver reads their own tanker's permits | PASS | PASS |
| STAFF-104 | a driver can't read other tankers' permits | PASS | PASS |
| STAFF-105 | a customer reads no permits | PASS | PASS |

### SAFE live-project safety

| ID | Check | PGlite | Supabase |
|---|---|---|---|
| SAFE-01 | non-test users and rows are byte-for-byte unchanged by the run | — | PASS |
