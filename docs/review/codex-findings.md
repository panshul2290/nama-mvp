# Repository review — 2026-10-28

Reviewed the working tree, including the existing uncommitted changes and `0014_live_fixes.sql`. Read `AGENTS.md`, `docs/REVIEW_GUIDE.md`, the installed Next.js proxy documentation, migrations 0001–0014, database harness/suites, and application code across the five surfaces; compared relevant flows with `prototype.html`. The initial pass was static with the permitted local checks. The supplementary browser review on 2026-10-29, described below, exercised the actual React components in an isolated preview. This is not a production certification or an exhaustive device test.

Only this report was written. No application, migration, test, or configuration files were edited; no commits or pushes were made. `.env.local` was not opened. No live database commands were run. Existing changes in `components/driver/legs.ts`, the database test harness/runner/platform suite, and migration 0014 were left intact.

## Verification

| Check | Result |
| --- | --- |
| `npm run test:db` | PASS: 428 passed, 0 failed, 5 skipped; fresh in-memory PGlite, PostgreSQL 18.6 |
| `npm run test:unit` | PASS: 19 tracking/routing checks and 4 privacy source checks |
| `npm run lint` | PASS, exit 0, no diagnostics |
| `npx tsc --noEmit -p . --incremental false` | PASS, exit 0, no diagnostics; incremental disabled to avoid writing a build-info file |

PGlite explicitly serializes transactions. Its concurrency passes do **not** establish safety under concurrent PostgreSQL backends. The five skips cover migration tracking, REST, source-check delegation, and Realtime privacy. Storage policies are conditionally skipped when the Supabase storage schema is absent, so the passing suite does not validate real storage access. Findings below are source-derived, with concrete reproduction scenarios; the attack sequences were not executed against a live service.

The documented gateway, IVMS/TFS/ROP, identity, messaging, SSO, and other integration simulations are intentional and are not reported as defects merely because they are simulated. Production rollout still requires their replacement. Public map services and overseas demo hosting are likewise documented constraints.

### Supplementary rendered UI review — 2026-10-29

**Method and isolation.** Used headless Chromium 155.0.8059.85 through the REA browser-scenario tooling, following the reverse-engineer-anything skill's runtime-observation instructions. Compiled the existing page/layout components and their actual CSS into memory with esbuild (`write:false`), served them on loopback, and populated a fresh, in-memory PGlite database from the migrations and demo SQL. The normal Next.js dev/build commands were not used because they load environment files and produce repository artifacts. No `.env.local` or other environment file was loaded. The supplementary preview used no live database credentials or live database connection.

The preview replaced Next navigation/link/dynamic plumbing and the Supabase client with local adapters. Database snapshots were selected under the fixture user's RLS role; RPC calls ran against PGlite under that user's role. Query filtering/embedded relationships were approximated by the adapter, rather than going through real PostgREST. Browser requests for external map/routing services were blocked by the preview CSP; blank map tiles are therefore **not** an application finding. The root Next font loader was omitted, so screenshots are not evidence about production typography. These qualifications matter: this is browser validation of the real components and local workflows, not an end-to-end test of a deployed Next.js/Supabase installation.

**Coverage.** Rendered 37 distinct implementation routes across the five surfaces, plus the prototype launcher. Used 390×844 for the phone apps and 1440×1000 for portals, with additional 320×740 wallet and 768×1024 NWS reports checks. Inspected screenshots and accessibility/DOM captures; checked the ordinary screen layouts for horizontal overflow and unnamed buttons. No page-wide overflow or unnamed buttons were found in the settled main-screen audit samples. This does not cover every dialog, error state, table size, browser, or assistive technology.

| Surface | Rendered routes / interactions | Outcome |
| --- | --- | --- |
| Customer | Home, orders, wallet, account, complaints, request wizard, contract wizard, order detail; English→Arabic toggle; all four checkout steps; invalid promo; wallet payment; wallet top-up | Rendered; Arabic/RTL switch worked. Invalid promo produced an inline message. A 3,000-gallon checkout displayed and debited 11.760 OMR, reducing the wallet from 30.000 to 18.240; a 5.000 top-up raised it to 23.240. Contract wizard was checked at its entry screen, not submitted. |
| Driver | Home, jobs, trip, earnings, profile; five safety-check items, submit, go online, accept the customer's new order | Safety-check gate worked in the UI. Going online showed the new order and 2.975 OMR earnings; Accept navigated to the filling leg. With location unavailable, the geofence action was disabled and the flagged override remained visible. Physical GPS, drawing a signature, camera upload, and native background tracking were not tested. |
| NWS | Live operations, orders, fleet, permits, customers, complaints, reports, privacy settings, individual order detail | Main screens rendered under the admin fixture; role-restricted operator/permit buttons remained disabled. Tablet reports rendered without page-wide overflow. Reproduced the signature image defect in G4. Staff mutations were not exercised through these disabled admin controls. |
| Company | Overview, tankers, drivers, compliance, permits, jobs/contracts, finance, shifts | All eight tabs rendered with fixture fleet/ledger data. Compared displayed shift hours against the driver's profile (G5). Registration, evidence upload, contract acceptance, and payouts were not submitted through the browser. |
| Business | Dashboard, orders, sites, contracts, invoices, team, service levels; Add site dialog, Tab/Shift+Tab, Escape | All seven tabs rendered. Add site opened, and Escape dismissed it. Reverse tabbing from its map moved focus to a background Delete button while the modal remained open (P5). Bulk ordering, invoice payment, and invitations were not submitted. |

The new order was placed and accepted **through the browser**. To prepare the separate signature-rendering test, the local fixture was then advanced through GPS/fill/arrival/POD RPCs using the same path-only signature format the driver component produces. That setup was not a browser camera/signature capture and is not represented as one.

An early fleet capture failed because the preview adapter omitted embedded permit arrays. After correcting the in-memory adapter, the fleet route rendered successfully; the adapter failure is excluded from application findings. An initial preview `process` shim failure was likewise corrected and excluded. An attempted prototype sign-in traversal used a selector absent from its customer flow and was cancelled; only the prototype launcher was successfully browser-validated. Prototype feature comparisons beyond the launcher remain source-based.

**Evidence.** Captures were inspected inline; no screenshot or harness files were added to the repository. These are session evidence identifiers and SHA-256 screenshot identities, not permanent file-download links:

| Observation | REA evidence identifier | Screenshot SHA-256 |
| --- | --- | --- |
| Customer Arabic/RTL | `ev_f64a02c713854cfec5cb9c9f3045eb9b1051fe8d887a6c31e872afe137e77132` | `90257224ed74d6ff8e8aa58be9a6202e7dbb3bb3dc10c21eb9f6274c0a24b458` |
| Checkout / requested order | `ev_56561c0ba2094ee1acaa7d58bba31350c5653c88a5da3039563997c0bc94ae34` | `00366a51098d254cc3cd8271739fb54086028cdd3be85b39d3857934b47c07ad` |
| Driver safety check / online / job offer | `ev_393a54202cdadb60d680eda1d39ed3c99c5fbc70558ff927f503ab7f5968a622` | `e8d1bbd92405c30a698ed997d45a5a1d8cde8f48b9a2484fd953c6ae09510f8a` |
| Company tabs / shift labels | `ev_e36c4fd9df1a7f421d97758698c61b924b820affea8042358ae87a29434a5182` | `ab2d9df5520a833f9b6bbc33bedd6eec435a45dfa14a3c6b8ec507b81f1a3068` |
| Modal focus escape | `ev_f6cc52e2115eeefdda5f753a1d6dc20dacda6d469a2fb309cdcd0b6188986d9c` | `99b8d4ba201e016e6e76e0d7241e77064f1968a3f845232067ecd720edc4bd86` |
| NWS broken signature | `ev_ba9166f9d8183ebba7787ccb4cc18e9dd1cc3c059e826d3344e3bc5c6de80109` | `16f54accacf0deb209f0cc7d8319e38d0aac35cc89a2b79fd62cc6912d2d82fb` |

## 1. Security and authorization

### S1 — Critical — Legacy checkout bypasses payment and can mint wallet credit

**Location:** `supabase/migrations/0004_pricing_rules.sql:232`; `supabase/migrations/0001_init.sql:425`; `supabase/migrations/0012_platform_rpcs.sql:260`.

**Problem:** The still-granted `place_order` RPC checks the customer role and basic input but does not enforce the newer checkout's account block, service-zone, or payment checks. It inserts an immediately dispatchable order with no payment. Cancellation then calls the refund helper, which credits the wallet even when no payment exists.

**Scenario:** A signed-in customer calls `place_order`, then `cancel_order` before acceptance, repeatedly. Every iteration creates wallet credit equal to the tariff without a debit. Alternatively, the customer lets a driver deliver the unpaid order. Blocking the account or disabling its zone does not stop this legacy endpoint.

**Suggested fix:** Revoke/remove the legacy RPC or route it through the same validated checkout and payment transaction. Independently fix the refund invariant in M1. Reject dispatch of prepaid orders without a valid payment authorization.

### S2 — High — Evidence bucket permits cross-account document and photo reads

**Location:** `supabase/migrations/0013_platform_reference.sql:113`.

**Problem:** `evidence_read` authorizes every authenticated user to select every object in the evidence bucket. The upload folder restriction does not restrict reads. Database RLS on PODs, complaints, and documents cannot protect the underlying files through this policy.

**Scenario:** An unrelated customer lists another user's evidence folder through Storage and downloads or signs URLs for licence scans, insurance documents, complaint photographs, or delivery photographs. Folder UUIDs and unpredictable filenames are not authorization.

**Suggested fix:** Restrict object reads to the uploader, authorized staff, and parties entitled to the associated evidence record. Use an evidence-to-object relationship and explicit party checks; test list, download, and signed-URL access across accounts on isolated Supabase infrastructure.

### S3 — High — Whole-profile SELECT exposes identity and private account fields to job parties

**Location:** `supabase/migrations/0001_init.sql:148`; `supabase/migrations/0001_init.sql:154`; `supabase/migrations/0010_platform_schema.sql:46`; `supabase/migrations/0011_platform_access.sql:185`.

**Problem:** Profiles have a table-wide SELECT grant. Policies that let a driver read the active customer's profile, or a contract company read its customer, therefore also expose later-added `id_no`, identity status, preferences, loyalty/account fields, and the real phone number. Selecting only name/phone in the UI does not restrict a direct API request. The driver UI labels the number masked while the raw phone remains queryable.

**Scenario:** A driver with an accepted job requests `profiles?select=*` for the customer and receives the identity number added by `verify_identity`. A company with a customer contract can read that customer's full profile through the contract policy.

**Suggested fix:** Separate private identity/account data from a minimal public party profile. Expose names and mediated contact information through narrow views/RPCs, with private fields readable only by the subject and specifically authorized staff.

### S4 — High — Email linking claims users without consent and races across tenants

**Location:** `supabase/migrations/0012_platform_rpcs.sql:1114`; `supabase/migrations/0012_platform_rpcs.sql:1283`.

**Problem:** `owner_add_driver` and `org_add_member` immediately attach an existing unlinked account by email, without an invitation acceptance. Their read/check/update sequences do not lock the target profile or predicate the update on the previous tenant being unchanged.

**Scenario:** A malicious owner who knows an independent driver's email attaches that driver and can absorb their unowned tanker. A business admin claims an unregistered business account. Two owners/admins concurrently linking the same unlinked profile both pass the checks; the later update can overwrite the first tenant assignment.

**Suggested fix:** Use expiring invitations accepted by the target account. Lock the target during acceptance and atomically check the expected tenant state. Never transfer a tanker merely because someone knows its driver's email.

### S5 — High — Suspending a company does not disable its fleet's dispatch privileges

**Location:** `supabase/migrations/0012_platform_rpcs.sql:2020`; `supabase/migrations/0012_platform_rpcs.sql:746`; `supabase/migrations/0012_platform_rpcs.sql:687`.

**Problem:** Company suspension changes only `companies.status`. Driver acceptance/open-request eligibility checks tanker online/block/permit status, without checking company status. Staff assignment also lacks the company-status check. Existing online tankers remain eligible.

**Scenario:** NWS suspends a company for a compliance problem. A driver with a valid permit continues to fetch and accept orders, or an operator assigns one of the suspended company's tankers. This contradicts the company layout's stated approval requirement.

**Suggested fix:** Centralize fleet eligibility and enforce active company status in all dispatch and online entry points. Define how suspension handles active jobs and notify affected drivers.

## 2. Money correctness

### M1 — High — Exhausted or missing payments fall through to unrestricted refunds

**Location:** `supabase/migrations/0012_platform_rpcs.sql:18`.

**Problem:** `refund_to_wallet` selects only authorized/captured/partially-refunded payments. If no eligible payment is found, it still inserts the requested wallet credit. Fully refunded and failed payments consequently lose their refund ceiling. The payment row is also read without a lock; complaint refunds lock the complaint rather than the shared order/payment.

**Scenario:** Staff fully refunds a paid order, then requests another refund: the fully refunded payment is excluded and the second amount is credited. Refunds on unpaid legacy orders also create money. Two complaints for one order can concurrently calculate remaining refundable value from the same payment snapshot.

**Suggested fix:** Return zero/reject when no refundable payment exists, lock the payment before calculating the remaining amount, and enforce cumulative refunds no greater than captured/debited value. Keep separately authorized goodwill out of the payment refund path and add idempotency keys.

### M2 — High — Wallet spending races across different orders and tips

**Location:** `supabase/migrations/0012_platform_rpcs.sql:225`; `supabase/migrations/0012_platform_rpcs.sql:342`.

**Problem:** Checkout and tipping read `wallet_balance` and subsequently append debits without a shared customer/account lock. Locking each tipped order does not serialize spending on different orders. A ledger sum cannot enforce a nonnegative balance by itself.

**Scenario:** With 6 OMR available, two simultaneous 5.460 OMR wallet checkouts both observe sufficient funds and both succeed. The same issue occurs between checkout and tipping or two different delivered-order tips.

**Suggested fix:** Acquire the same customer wallet lock in every debit path before checking and posting, or atomically debit an account balance row and append its ledger entry. Test with separate PostgreSQL connections.

### M3 — High — Arbitrary tip methods create unfunded company earnings

**Location:** `supabase/migrations/0012_platform_rpcs.sql:340`.

**Problem:** A positive tip debits the customer only when `p_tip_method = 'wallet'`, but always credits the tanker company. No alternate method validation or payment record exists.

**Scenario:** A customer rates a delivered job with `p_tip=20` and `p_tip_method='anything'` (or NULL). The company gains 20 OMR eligible for payout and the customer pays nothing. The shipped UI always using wallet does not protect the RPC.

**Suggested fix:** Reject unsupported or NULL methods. For any supported non-wallet method, require a successful payment and a unique funded tip transaction before crediting earnings.

### M4 — High — Concurrent invoice generation duplicates debt or mismatches invoice lines

**Location:** `supabase/migrations/0012_platform_rpcs.sql:1307`.

**Problem:** `invoice_org` calculates totals, inserts an invoice, then independently updates all currently eligible orders. The organization and the selected orders are not locked by this helper. `org_generate_invoice` does not acquire the organization lock used by `staff_org_action`.

**Scenario:** Two finance sessions generate an invoice simultaneously. Both calculate the same delivered orders and create a full-value invoice; only one may acquire the order links, leaving a second collectible invoice with no lines. An order delivered between the aggregate and UPDATE can instead be linked without being included in the totals.

**Suggested fix:** Serialize invoicing per organization, lock/materialize the exact order IDs, and derive totals and invoice lines from that fixed set. Use explicit invoice lines with a unique order reference.

### M5 — High — Credit limits can be exceeded concurrently and through approvals/contracts

**Location:** `supabase/migrations/0012_platform_rpcs.sql:1235`; `supabase/migrations/0012_platform_rpcs.sql:1262`; `supabase/migrations/0014_live_fixes.sql:20`.

**Problem:** Bulk ordering checks outstanding credit without locking the organization. Pending-approval orders are excluded from outstanding credit, and approval never rechecks capacity. Contract generation does not check organization activation, pause, approval limits, or remaining credit.

**Scenario:** With 100 OMR remaining, two concurrent 80 OMR batches both succeed. Alternatively, several pending batches each fit individually, then an admin approves all of them after other spending consumes the credit. A paused business still receives new account orders from an active contract.

**Suggested fix:** Reserve credit under an organization lock at the appropriate lifecycle stage, revalidate when approving, and use the same credit/account eligibility service for contract generation. Explicitly release reservations on cancellation and payment.

### M6 — High — Household contract deliveries have no collection/invoicing path

**Location:** `supabase/migrations/0014_live_fixes.sql:20`; `supabase/migrations/0012_platform_rpcs.sql:1301`.

**Problem:** Generated contract orders are always `billing='account'`, `pay_method='account'`, and `payment_status='on_account'`. Household contracts have no organization, while invoicing and invoice payment operate only on organizations. Generation creates no payment authorization, and settlement still awards company earnings. The browser-rendered wallet advertises an “Auto-pay contracts and invoices” toggle that uses wallet then card, and the contract wizard promises automatic monthly charging, but `autopay` is only stored/read as a UI preference; no migration collection path consumes it (`app/customer/wallet/page.tsx:151`, `app/customer/contract/page.tsx:298`). This corroborates the missing collection flow rather than constituting a second counted finding.

**Scenario:** A household customer signs a weekly contract and the owner accepts. Deliveries complete and the company earns money, but the customer is never charged and cannot receive/pay an account invoice through the implemented flow.

**Suggested fix:** Define household recurring collection explicitly: authorize each occurrence from a wallet/card mandate, or implement household invoices and collections. Do not release unfunded household deliveries or make their earnings payable before the agreed funding condition.

### M7 — High — Short delivery charges full price without the promised customer refund

**Location:** `supabase/migrations/0012_platform_rpcs.sql:909`; `app/business/sla/page.tsx:137`.

**Problem:** POD settlement captures the full order price and credits full earnings. A short meter reading only creates a penalty/alert; it does not refund the customer or adjust an account receivable. The business SLA screen explicitly says shortages over 5% are refunded.

**Scenario:** A 3,000-gallon delivery records 2,000 gallons. The customer pays for all 3,000, company earnings are based on the full fee, and the account invoice remains full value despite the shortage flag.

**Suggested fix:** Define a shortage adjustment policy and atomically post the prepaid refund or account credit note alongside settlement. Keep any company penalty distinct from the customer's reimbursement.

### M8 — High — Production pricing confirmation omits contract discount rules

**Location:** `supabase/migrations/0011_platform_access.sql:254`; `supabase/migrations/0011_platform_access.sql:264`; `supabase/migrations/0011_platform_access.sql:282`.

**Problem:** `order_discount_pct` reads `discount_monthly`/`discount_yearly`, but `price_quote_ext.rules_used` contains the base rules and multipliers, not the discount rule. The discount rule's status is also absent from total status propagation. Production validation only examines `rules_used`.

**Scenario:** NWS confirms all base tariff rules and enables production billing while the yearly discount remains an assumption. Yearly contract orders still receive that unconfirmed discount and pass the production guard.

**Suggested fix:** Carry discount rule identity, source, status, and value into the quote and frozen price basis; include them in confirmation checks and status aggregation.

### M9 — Medium — Promotion limits are checked before an unlocked increment

**Location:** `supabase/migrations/0012_platform_rpcs.sql:202`; `supabase/migrations/0012_platform_rpcs.sql:251`.

**Problem:** Promotion eligibility reads `uses < max_uses`, but usage is incremented later without a conditional bound or a prior row lock.

**Scenario:** A promotion has one redemption left. Two customers check out concurrently; both obtain the discount and `uses` exceeds `max_uses`.

**Suggested fix:** Reserve a use with a conditional UPDATE returning the eligible promotion under lock, in the checkout transaction. Define whether failed/cancelled checkouts consume a redemption.

### M10 — Medium — Rescheduling changes peak eligibility without reconciling the price

**Location:** `supabase/migrations/0012_platform_rpcs.sql:311`; `supabase/migrations/0012_platform_rpcs.sql:1520`.

**Problem:** Customer and staff rescheduling change slot timestamps without updating the peak classification or reconciling the frozen price. Peak pricing is tied to the booked time in initial checkout.

**Scenario:** A customer books a morning delivery and reschedules it to 18:00–20:00; the order keeps its off-peak tariff and `slot_peak=false`, unlike an identical order initially booked for the evening.

**Suggested fix:** Define whether rescheduling preserves the original tariff. If peak changes require repricing, create an audited price adjustment and collect/refund the difference; if price is preserved intentionally, store both original and current slot classifications and explain that policy in the UI.

## 3. Order, permit, and contract state machines

### T1 — High — Legacy completion bypasses POD and wastewater discharge

**Location:** `supabase/migrations/0012_platform_rpcs.sql:955`; `supabase/migrations/0001_init.sql:425`.

**Problem:** The legacy, authenticated `mark_delivered` RPC moves any assigned arrived order directly to delivered and settles it. It has no POD, meter, signature, filling, service-type, or discharge requirement.

**Scenario:** A wastewater driver calls `mark_arrived`, then `mark_delivered`. The order skips collection and treatment-plant discharge, releases the driver's active-job slot, and credits earnings without evidence or an outside-discharge penalty.

**Suggested fix:** Revoke this endpoint or make it a guarded wrapper over the canonical evidence-based transition. Maintain one server-side transition implementation for each service type.

### T2 — High — Pausing/ending contracts leaves runnable occurrences

**Location:** `supabase/migrations/0012_platform_rpcs.sql:603`; `supabase/migrations/0012_platform_rpcs.sql:608`; `supabase/migrations/0012_platform_rpcs.sql:785`.

**Problem:** Pause changes only the contract row. End cancels only scheduled orders, leaving already released requested occurrences. Release and acceptance check order status/company, but not whether the contract remains active.

**Scenario:** The owner accepts a contract and the system schedules deliveries. The customer pauses it before the next slot, but the scheduled order is released and delivered anyway. Ending after the 90-minute release point similarly leaves the requested order available.

**Suggested fix:** Under a shared contract lock, stop or cancel all unstarted occurrences on pause/end and check contract activity when releasing/accepting. Define handling for already accepted jobs and regeneration on resume.

### T3 — High — Contract generation is not concurrency-idempotent

**Location:** `supabase/migrations/0014_live_fixes.sql:18`; `supabase/migrations/0010_platform_schema.sql:185`.

**Problem:** Generation uses `NOT EXISTS` followed by INSERT without locking the contract or enforcing uniqueness of `(contract_id, slot_start)`. The existing index is nonunique. Migration 0014 narrows acceptance's side effects but retains this race.

**Scenario:** Two staff dashboards call `staff_scan` together, or a scan overlaps owner acceptance. Both see an absent occurrence and insert the same scheduled delivery, creating duplicate deliveries and account charges.

**Suggested fix:** Add a suitable unique occurrence key, insert with conflict handling, and lock contracts consistently with pause/end and generation.

### T4 — High — Contract renewal and operational scans depend on open browser pages

**Location:** `supabase/migrations/0012_platform_rpcs.sql:1349`; `app/nws/page.tsx:132`; `supabase/migrations/0014_live_fixes.sql:16`.

**Problem:** Contract generation covers only the next seven days. The checked-in operational invocation is a staff browser timer; no deployed database/server scheduler is defined in the repository. Driver polling releases scheduled orders but does not generate future contract occurrences or run the full alert/penalty scan.

**Scenario:** Nobody opens the NWS dashboard for more than a week. Active contracts run out of generated deliveries; lateness, signal-loss, and fraud checks stop executing despite settings text saying scans run on a schedule.

**Suggested fix:** Deploy a monitored server/database scheduler with a restricted service identity, retries, and run history. Treat browser scans as manual refreshes, with generation idempotency as in T3. An externally configured scheduler could mitigate this, but was not verifiable from this repository.

### T5 — High — Permit approval does not enforce the advertised prerequisites

**Location:** `supabase/migrations/0008_nws_staff.sql:348`; `supabase/migrations/0008_nws_staff.sql:109`; `supabase/migrations/0012_platform_rpcs.sql:1837`.

**Problem:** Approval requires only a pending permit. It does not require the decision stage, approved documents, a passed inspection for that tanker/permit, or successful automatic checks. Stages can jump arbitrarily. Permit validity checks expiry but not `issued_at <= now()`.

**Scenario:** A permit officer directly approves a newly submitted application with missing documents and no inspection. Its tanker can go online. A future-dated permit can also authorize operation before its issue date.

**Suggested fix:** Enforce sequential transitions and approval prerequisites in the database; validate inspection-to-tanker/permit relationships and the complete validity interval. Any override should be explicit, restricted, and audited with a reason.

### T6 — High — Assignment changes race with job acceptance

**Location:** `supabase/migrations/0012_platform_rpcs.sql:1132`; `supabase/migrations/0012_platform_rpcs.sql:1149`; `supabase/migrations/0012_platform_rpcs.sql:746`.

**Problem:** Assignment/unassignment checks for active jobs separately from changing assignments. Acceptance reads its assigned tanker and then updates the order without locking that assignment against reassignment. Unique indexes prevent two simultaneous active jobs, but do not ensure an order's driver remains the tanker's current assignee.

**Scenario:** An owner unassigns a tanker after checking it is free while the old driver is accepting an order using a previously read assignment. Both transactions commit, leaving an active job assigned to a driver who no longer has access to that tanker or its GPS/reporting RPCs.

**Suggested fix:** Lock the tanker/active assignment in a consistent order for both dispatch and assignment changes; recheck eligibility under that lock. Add a true multi-connection regression test.

## 4. Gaps versus prototype.html across the five apps

### G1 — Medium — Site-scoped business access is absent

**Location:** `prototype.html:1138`; `app/business/team/page.tsx:10`; `supabase/migrations/0011_platform_access.sql:188`; `supabase/migrations/0012_platform_rpcs.sql:1239`.

**Problem:** The prototype describes team access by site. The implemented business model has only organization-wide membership/roles and no member-to-site grants. Reads of orders, exact locations, properties, and invoices generally depend only on organization membership; a site manager can submit orders for any organization site. Finance's advertised invoice/payment access is not a read restriction in RLS.

**Scenario:** A hotel group's manager responsible for one property can query other properties' delivery addresses and order for them. The team UI offers no way to restrict that scope.

**Suggested fix:** Add site membership/permissions and enforce them in both RLS and write RPCs, or explicitly narrow the MVP's advertised access model until that capability exists.

### G2 — Medium — Arabic/RTL coverage stops at the mobile surfaces

**Location:** `lib/i18n.tsx:3`; `components/portal/PortalShell.tsx:49`; `app/business/team/page.tsx:10`.

**Problem:** Customer and driver dictionaries are implemented, but NWS/company/business navigation, dialogs, tables, status labels, and formatting remain predominantly English literals. The shared portal shell does not provide equivalent localized content and direction behavior. This is a remaining parity gap, not a claim that the implemented mobile translations are absent.

**Scenario:** An Arabic-speaking operator or company owner uses the portals and cannot switch their operational workflow to a complete Arabic/RTL experience.

**Suggested fix:** Extend the translation/direction system to the three portals, including dates/numbers, accessible labels, validation, and notification previews; validate each surface in RTL. The deferred backlog acknowledges this work but understates the mobile coverage already delivered.

### G3 — Medium — Driver's prototype filling-credit workflow is missing for independent tankers

**Location:** `prototype.html:1171`; `app/driver/earnings/page.tsx:59`; `supabase/migrations/0012_platform_rpcs.sql:877`.

**Problem:** The prototype provides a prepaid filling balance and top-up in the driver app. The implementation gives company owners the top-up RPC; independent tankers have no company balance, and `confirm_fill` skips the credit ledger entirely when `company_id` is NULL. The driver earnings view shows usage rather than an equivalent independent prepaid account/top-up flow.

**Scenario:** A self-registered independent driver completes water fills without any filling-credit deduction or ability to replenish such a balance, whereas a company driver creates filling-credit ledger charges.

**Suggested fix:** Define the independent-driver commercial model and implement its funded filling account, or require company registration before paid operation. Make the UI and prototype scope explicit about which model applies.

### G4 — Medium — NWS renders driver signatures as broken images

**Location:** `components/driver/TripSheets.tsx:98`; `app/nws/orders/[id]/page.tsx:223`; `app/nws/orders/[id]/page.tsx:551`.

**Problem:** The driver's signature pad produces SVG path commands, such as `M10 10L20 20L40 10`, and stores that string in `signature_svg`. The customer POD card handles both a complete SVG document and path-only data, but NWS always encodes the value as a complete `image/svg+xml` document. A path string is not a valid standalone SVG image.

**Scenario:** A driver completes POD with a drawn signature. In the isolated browser test, a POD using the driver's path format showed “Signed” in NWS order detail but a broken image with the “Customer signature” alt text in place of the signature. The final screenshot and DOM capture are recorded above. This was independent of the deliberately unavailable photo storage.

**Suggested fix:** Use one shared signature renderer that recognizes the stored format and renders path-only values inside a bounded `<svg><path .../></svg>`, as the customer card already does. Standardize the stored representation and support existing records during migration.

### G5 — Medium — Company and driver screens disagree on day-shift hours

**Location:** `app/company/shifts/page.tsx:12`; `components/driver/i18n.ts:394`.

**Problem:** The same stored `shift='day'` appears as “Day 06–14” in the company portal, while the driver profile explains “Day 06:00–18:00”. The inconsistency was observed in both rendered screens. Evening/night labels agree, making this a specific discrepancy rather than just different formatting.

**Scenario:** An owner schedules a day shift expecting the driver to finish at 14:00; the driver reads that the same shift lasts until 18:00. Staffing, emergency callouts, and availability expectations differ by four hours.

**Suggested fix:** Define shift intervals once, share them across surfaces and translations, and make any dispatch enforcement use the same Muscat-time intervals.

## 5. Production readiness

### P1 — High — Background GPS collection does not guarantee background transmission

**Location:** `lib/geo-source.ts:37`; `components/DriverContext.tsx:236`; `components/DriverContext.tsx:425`.

**Problem:** The native location callback updates JavaScript state, while upload is driven by a WebView `setInterval`. No native uploader or persistent fix queue is implemented. A foreground location service gathering fixes does not itself make a suspended WebView execute its upload timer.

**Scenario:** On Android, the driver locks the screen or the OS suspends the WebView during a trip. Native fixes may continue, but server updates stop or are heavily throttled, leaving the fleet map stale and potentially triggering signal-loss rules. Network failures keep only the latest in-memory fix.

**Suggested fix:** Send/queue fixes from a supported native background execution path, persist pending samples with bounded retention, and flush idempotently on reconnect. Verify on physical Android devices under screen lock, battery restrictions, and process restart. This risk was established from architecture; actual APK behavior was not device-tested.

### P2 — Medium — Failed photo uploads still permanently complete PODs

**Location:** `components/driver/TripSheets.tsx:89`; `supabase/migrations/0012_platform_rpcs.sql:902`.

**Problem:** After two upload failures, the client submits only a hash. The server accepts a hash instead of an object and immediately settles the order. There is no persistent photo upload queue or follow-up reconciliation, and the server accepts arbitrary/empty hash strings without verifying an owned object.

**Scenario:** A driver's photo upload fails on a poor connection but the RPC succeeds. The order becomes delivered and paid; the customer/NWS can never view the photo after the component is closed. A direct caller can submit an invented hash for the same effect.

**Suggested fix:** Persist pending evidence and upload jobs locally; keep delivery evidence pending until a validated private object exists, or explicitly distinguish operational completion from evidence acceptance and hold settlement as required. Validate object ownership and hash server-side.

### P3 — Medium — Fleet/finance totals silently truncate and query failures look empty

**Location:** `components/company/CompanyContext.tsx:153`; `components/company/CompanyContext.tsx:170`; `app/nws/reports/_tabs/data.ts:8`; `components/nws/admin/ui.tsx:210`.

**Problem:** Company order queries cap at 1,000, ledger queries request 2,000 without pagination (the API may cap lower), and reports cap at 5,000. These are aggregated as period totals without a reliable completeness signal. Several company queries discard errors and set loaded=true with empty data.

**Scenario:** A busy company has 1,500 jobs or more than the API's ledger limit in the reporting window; revenue/performance/statement totals omit transactions. A transient permission/network failure displays no jobs or ledger entries instead of an error.

**Suggested fix:** Compute financial/operational aggregates server-side over the full authorized dataset, paginate detail/export views, expose truncation explicitly, and retain previous data while showing actionable query errors.

### P4 — Medium — CSV exports allow spreadsheet formula injection

**Location:** `components/portal/kit.tsx:52`; `components/nws/ops.tsx:125`; `components/nws/admin/ui.tsx:59`.

**Problem:** CSV escaping handles delimiters and quotes but leaves user-controlled cells starting with spreadsheet formula characters unchanged. CSV quoting alone does not make formulas inert.

**Scenario:** A customer/company enters a name beginning with `=HYPERLINK(...)`. Staff exports a report containing that value and opens it in spreadsheet software, which interprets the cell as a formula/link rather than literal data.

**Suggested fix:** Use one shared spreadsheet-safe exporter that neutralizes formula-leading text (including leading control/whitespace variants) and test with common spreadsheet applications. Keep numeric monetary cells typed appropriately.

### P5 — Medium — Modal dialogs do not contain keyboard focus

**Location:** `components/portal/kit.tsx:162`; `components/customer/ui.tsx:13`; `components/driver/Sheet.tsx:11`.

**Problem:** The dialog/sheet primitives advertise `aria-modal=true` without making the background inert or trapping/restoring keyboard focus. Escape handling in some primitives does not solve focus containment. The business dialog failure was reproduced in the browser; the related mobile primitives have the same missing containment mechanism on source inspection.

**Scenario:** Open Business → Sites → Add site. Focus the dialog map, then press Shift+Tab. The observed active element becomes a background `<button class="btn sm">Delete</button>` with `inDialog=false` and `dialogOpen=true`. A keyboard user can therefore reach background controls while a visually modal form is open, potentially losing context or activating an unintended action.

**Suggested fix:** Use an accessible dialog primitive or implement initial focus, a Tab/Shift+Tab focus loop, an inert background, consistent Escape handling, and restoration to the trigger. Validate nested dialogs, mobile sheets, and keyboard-only workflows.

## 6. Code quality

### Q1 — Medium — Duplicated SLA rules produce contradictory performance figures

**Location:** `components/company/CompanyContext.tsx:178`; `app/nws/reports/_tabs/data.ts:54`; `app/driver/earnings/page.tsx:16`; `components/business/data.ts:1`.

**Problem:** Company metrics use delivery by slot end or 90 minutes from creation; NWS metrics prefer arrival and use two hours from release/creation; driver metrics use arrival within an hour of acceptance; business metrics use delivery and a two-hour ASAP allowance. These are materially different definitions presented as on-time performance.

**Scenario:** An ASAP order accepted 45 minutes after request and delivered 100 minutes after request is late in the company portal but on time in the business portal. A driver arriving before slot end but delivering afterwards can pass NWS metrics and fail customer-facing metrics.

**Suggested fix:** Agree on named business metrics, centralize their definitions (preferably authoritative database views), and show distinct labels when arrival, delivery, dispatch, or service-specific discharge SLAs intentionally differ. Use Muscat-based period boundaries consistently instead of browser-local midnight/week calculations.

### Q2 — Low — Deferred/design documentation contradicts implemented features

**Location:** `docs/backlog-deferred.md:3`; `docs/backlog-deferred.md:9`; `docs/backlog-deferred.md:12`.

**Problem:** The backlog says none of its listed items are built, including permit reject/resubmit, B2B approval/finance roles, and failure states. The repository now has staff review/resubmit RPCs, business roles/approval/invoices, checkout failure handling, and an incident screen. Its linked filling/discharge design is also described as unimplemented despite the implemented RPCs. This obscures real gaps versus partial or completed work.

**Scenario:** A reviewer or production team plans to build an already implemented workflow from scratch, or assumes a flow is deliberately absent and misses defects in its existing implementation.

**Suggested fix:** Reconcile the backlog/design/evidence documentation against current code, distinguish completed, partial, simulated, and still-deferred capabilities, and link each entry to its implementation and remaining acceptance criteria.

## Limits and follow-up verification

No live PostgREST, Storage, Realtime, external scheduler, deployed gateway, or physical Android behavior was verified. The supplementary browser work above validates rendered components, selected interactions, and some accessibility/layout behavior under local adapters. It does not validate production Next routing/SSR/hydration/session refresh, real authentication, complete PostgREST query semantics, real evidence uploads, external map tiles/routing, screen-reader use, or native APK behavior. No production build was run; a Next.js build can load local environment files. Cross-tenant SQL policies and money/state paths received priority; complete screen-by-screen prototype parity remains unproven. Race scenarios require an isolated PostgreSQL/Supabase test environment with independent connections, not the prohibited live target.

Existing safeguards worth preserving include explicit RPC execution revocation for internal helpers, role checks on staff mutations, append-only audit triggers, immutable order pricing, unique active driver/tanker job indexes, and a payout-batch advisory lock. The findings concern paths and invariants those safeguards do not currently cover.

## Summary

| Severity | Count |
| --- | ---: |
| Critical | 1 |
| High | 19 |
| Medium | 12 |
| Low | 1 |
| **Total** | **33** |
