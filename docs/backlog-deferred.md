# Backlog: built, simulated, deferred

Reconciled with the code after the external review (`docs/review/codex-findings.md`) and migration `0015_review_fixes.sql`.
Items that were once listed here as "not built" and now exist are under **Built**, so nobody plans them from scratch.

## Built

| Item | Where |
|---|---|
| Incident SLA screen: P1–P4 targets, response/resolution clocks, acknowledge/resolve, audit | `app/nws/settings/health`, `staff_open_incident`, `staff_incident_action` |
| Permit review: stages submitted → documents → inspection → decision (one step at a time), request info, reject with a reason, resubmit, audit trail. Applications can be approved only at the decision stage after a passed inspection (0015, T5) | `app/nws/permits`, `staff_permit_stage`, `staff_review_permit`, `staff_resubmit_permit` |
| Proof of delivery: meter reading, signature, and a photo that must be uploaded to the driver's own `evidence/<uid>/…` folder before `submit_pod` accepts it (0015, P2/T1). `mark_delivered` needs a POD on file and never applies to wastewater | `components/driver/TripSheets.tsx`, `submit_pod` |
| Short-delivery refund: a meter reading under 95% refunds the missing share to the wallet (prepaid) or credits it against the account invoice (business), separately from the company penalty (0015, M7) | `submit_pod`, `orders.short_credit`, customer and NWS order detail |
| Filling and discharge legs: `confirm_fill` at the nearest fill station and `confirm_discharge` at an approved site (wastewater), checked against the geofence and a fresh GPS fix, recorded in `source_events`, with alerts and penalties when outside | `confirm_fill`, `confirm_discharge`, driver trip screen. The device events are simulated (see below and the design note) |
| Customer failure states: declined card, insufficient wallet, outside service area / zone disabled, offline banner, reschedule that would change the price | customer request and order screens, `lib/errors.ts` |
| B2B accounts: admin / site manager / finance roles, approval limits, credit limit and terms, invoices and payment | `app/business/*`, `org_create_orders`, `org_decide_order`, `invoice_org` |
| Invitations: company owners invite drivers and business admins invite users; the invitee accepts or declines in their own app; invitations can be revoked and expire after 14 days (0015, S4) | `owner_add_driver`, `org_add_member`, `respond_invitation`, `revoke_invitation` |
| Arabic / RTL for the two phone apps (customer and driver) | `components/customer/i18n.ts`, `components/driver/i18n.ts` |
| Private profile fields (ID number, preferences, loyalty) readable only by the person and by staff (0015, S3) | `my_private_profile`, `staff_private_profiles` |
| Control-room scan on a database schedule (pg_cron, every minute) where the extension is available; dashboards still scan as a manual refresh (0015, T4) | `staff_scan` |

## Simulated on purpose (demo only; replace for production)

- **Payments:** simulated gateway (card ending 0002 is declined); card tips and household contract auto-pay are recorded as simulated card charges.
- **Telematics and meters:** IVMS valve/flow readings, filling-station (TFS) transactions and treatment-plant (STP) discharge events are derived from the driver's phone GPS, not from authoritative devices.
- **Government and partner systems:** ROP vehicle checks, national ID verification, water-quality LIMS, Genesys call centre, NWS SSO.
- **Messaging:** SMS, WhatsApp and push are written to `notifications` and shown in-app; nothing is sent.
- **Maps and hosting:** public OSM tiles, OSRM routing and Nominatim geocoding; Supabase is hosted outside Oman.
- **Scheduled report exports** in XLSX/PDF (CSV downloads are real).

## Still deferred (until tender go/no-go)

| # | Item | What it would cover | Review ref |
|---|---|---|---|
| 1 | Site-scoped business access | Grant members access to specific sites and enforce it in RLS (orders, locations, invoices) and in the ordering RPCs. Today membership and roles are organisation-wide. | G1 |
| 2 | Arabic / RTL for the desktop portals | NWS, Company and Business portals: translations, RTL layout, date/number formatting, accessible labels, notification previews. The phone apps are already bilingual. | G2 |
| 3 | Independent-driver filling-credit account | A prepaid filling balance and top-up for drivers without a company (company fleets have one via `owner_topup_fill_credit`), or company registration required before paid work. | G3 |
| 4 | SMS OTP sign-in | Phone-number login with one-time codes. Sign-in is email + password only. | — |
| 5 | Real integrations | Payment gateway, IVMS, TFS/STP meters, ROP, national ID, LIMS, Genesys, SMS/WhatsApp/push providers, NWS SSO, in-country maps and hosting. | — |
| 6 | Driver offline capture | A persistent on-device queue for GPS fixes, trip steps and POD photos that syncs on reconnect; background upload verified on physical Android devices. | P1, P2 |
| 7 | POD rejection workflow | Customer/NWS rejection of a POD with a reason and follow-up; today disputes go through complaints and refunds. | — |
| 8 | Server-side reporting aggregates | Period totals computed in the database over the full dataset; the portals cap detail queries and say so ("Showing the latest N"). | P3 |

Related design note: [filling and discharge verification](design/filling-discharge-verification.md).
