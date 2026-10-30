# Review guide (for external code reviewers, e.g. Codex)

This repo is a working demo of the Nama Water Services tanker platform (tender T/2757176/2026),
built to prototype parity with `prototype.html`. If the bid is won it becomes the base for a
6-month production build, so review it as the foundation of a production system.

## Ground rules for the reviewer
- **Read and report only.** Do not edit code, commit, or push. Write findings to `docs/review/codex-findings.md`.
- **Never touch the live database.** Do not run `npm run seed`, `npm run seed:demo`, `npm run db:apply`,
  `npm run test:db:supabase`, `npm run evidence` or `npm run demo`, and do not read or print `.env.local`.
- Safe to run: `npm run test:db` (in-memory PGlite built from the migrations, ~2 min), `npm run test:unit`,
  `npm run lint`, `npx tsc --noEmit -p .`, `npm run verify:seed` (seed dry run on PGlite).
- `AGENTS.md`: this Next.js version (16) differs from older ones; check `node_modules/next/dist/docs/`.

## Architecture in one page
- **Five surfaces, one Next.js app:** customer app `app/customer`, driver app `app/driver` (both phone UIs,
  also shipped as Android APKs via Capacitor in `mobile/`), NWS staff portal `app/nws`, tanker company portal
  `app/company`, business (B2B) portal `app/business`. Launcher and sign-in: `app/page.tsx`, `app/login`, `app/signup`.
- **All pages are client components** talking to Supabase with the publishable key. Security lives in Postgres:
  - Signed-in users only ever `SELECT`, filtered by row-level security (RLS).
  - **Every write is a `SECURITY DEFINER` RPC** that checks the caller's role and the allowed transition;
    staff RPCs check the staff sub-role and write exactly one `audit_log` row (append-only).
- **Database:** `supabase/migrations/0001…0014` (0026–0029: notification delivery, dynamic pricing, auto-dispatch, driver filling credit, SLA in SQL, per-site business access, privacy enforcement, field encryption (`docs/security/field-encryption.md`), incident matrix, IVMS feed, integration API `/api/v1` (`docs/api/openapi.yaml`) and webhooks, server-side reports) (0009–0014 are the full platform: payments/wallet/ledgers,
  trip legs + proof of delivery, complaints, alerts, penalties, companies, contracts, B2B, notifications,
  settings). Reference data: `0013`. Demo data: `supabase/seed/demo.sql`.
- **Pricing:** every tariff figure is a row in `pricing_rules` with a status (confirmed / pending NWS
  clarification / assumption); a trigger prices each order and freezes it (`0004`, `0011`).
- **Tests:** `supabase/tests/suites/*.ts` (authorization matrix, lifecycle, pricing, races, GPS, privacy,
  staff, platform workflows), `tests/unit/*`.

## Deliberately simulated (not bugs)
Payment gateway (card ending 0002 = declined), IVMS telematics, filling-station meters (TFS), ROP vehicle checks,
SMS/WhatsApp/push/email providers (messages go through `notification_outbox` and a built-in simulated provider; real gateways plug in through the integration API, 0026/0028), IVMS hardware (the integration API ingests fixes; a built-in simulator feeds it, 0028), Genesys call centre, national ID check, water-quality LIMS,
NWS SSO. Map tiles/routing/geocoding use public OSM/OSRM/Nominatim (demo only). Sign-in is mobile number (or email) + password; SMS codes verify the number and reset passwords, written to `sms_outbox` by a Postgres Send SMS hook with no SMS gateway yet (`docs/mobile-auth.md`).
Supabase is hosted outside Oman for the demo.
The "Test – India" service zone (`0020`, `zones.is_test`) is deliberate: it lets the team test from India, accepts fill/discharge at the tanker's position on test orders, and must be switched off for production (README, "Testing from India").

## What to look for (in priority order)
1. **Security / authorization:** RLS policy gaps (who can read what), RPCs that trust client input, missing role
   checks, privilege escalation (role/staff_role changes), storage bucket policies, PII exposure
   (exact customer location, phone numbers), anything that lets one customer/company/business see another's data.
2. **Money correctness:** wallet, payments, refunds, cancellation fees, tips, company earnings, penalties and
   reversals, payout batches, invoices and credit limits. Double-spend, double-refund, rounding (3 decimals OMR),
   races between concurrent calls.
3. **State machines and races:** order status transitions, accept/assign races, scheduled-order release,
   contract order generation, permit stages.
4. **Correctness vs. the prototype:** missing or broken flows compared with `prototype.html`.
5. **Production readiness:** error handling, offline behaviour, background GPS in the driver APK
   (`lib/geo-source.ts`), performance of queries (missing indexes, client-side aggregation in reports),
   Arabic/RTL coverage, accessibility.
6. **Code quality:** duplication, dead code, inconsistent patterns across the five surfaces.

## Findings format
For each finding: severity (critical / high / medium / low), file:line, what is wrong, a concrete scenario that
triggers it, and the suggested fix. Group by the six areas above. Note anything you could not verify.
