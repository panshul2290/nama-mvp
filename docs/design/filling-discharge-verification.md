# Design note: verifying fills and discharges

**Status:** partly implemented. `confirm_fill` and `confirm_discharge` record fill and discharge events in `source_events`, matched to the nearest station/site geofence and a GPS fix under 5 minutes old, with alerts and penalties when outside; proof of delivery needs an uploaded photo (`submit_pod`). The authoritative events (TFS transactions, IVMS valve/flow readings) are still simulated from the driver's phone GPS, so by the rule below these records are not yet truly verified.

## Rule

A fill (tanker loads at an NWS filling station) or a discharge (wastewater emptied at an approved site) counts as **verified** only when:

1. there is an **authoritative event** from a system other than the driver's phone:
   - a **filling-station / TAS transaction**, identified by the station's transaction ID, or
   - an **IVMS valve or flow reading** from the device fitted to the tanker; and
2. the event is **matched to a geofence**: the station's or site's polygon contains the tanker's IVMS position at the time of the event; and
3. the event is **matched to a time window**: it falls inside the trip's expected window, and the volume agrees within tolerance.

**GPS proximity alone is never enough.** The phone being inside a geofence, or the driver tapping "filled", produces at most an **unverified** record. It can be shown to operators, but it must not count as compliant, release payment, or count toward quota.

## Data model (proposed)

```text
sites            (id, kind: filling_station | discharge_site, name, operator,
                  geofence: polygon, service_types[], active)

devices          (id, kind: ivms, tanker_id, serial, installed_at, active)

source_events    — raw, append-only, as received from external systems
  id, source: tas | ivms, external_id (TAS transaction ID / IVMS message ID),
  tanker_id, site_id NULL, event_type: fill_start | fill_end | valve_open |
  valve_close | flow_total, volume_gal NULL, position NULL, occurred_at,
  received_at, payload jsonb, signature_ok bool
  UNIQUE (source, external_id)          -- idempotent ingestion

trip_legs        — the fill/discharge step of a job
  id, order_id, leg: fill | discharge, site_id, expected_gal,
  window_start, window_end, state (below), verified_by_event_id NULL,
  reason NULL, created_at, updated_at

verification_audit — append-only history of every state change
  id, trip_leg_id, from_state, to_state, actor (system | operator id),
  event_ids[], reason, at
```

## States of a trip leg

| State | Meaning | Counts as compliant? |
|---|---|---|
| `pending` | leg created, nothing received yet | no |
| `unverified` | only phone evidence: driver tap and/or phone GPS inside the geofence | no |
| `verified` | authoritative event matched to the geofence, time window and volume tolerance | **yes** |
| `mismatch` | authoritative event exists but fails a match: wrong site, outside the window, or volume off | no; operator review |
| `missing` | window closed with no authoritative event | no; operator review |
| `overridden` | an operator decided after review, with a mandatory reason | as decided, flagged in reports |

```text
pending ──(phone GPS / driver tap)──▶ unverified
pending | unverified ──(TAS or IVMS event, all matches pass)──▶ verified
pending | unverified ──(event, a match fails)──▶ mismatch
pending | unverified ──(window closes, no event)──▶ missing
mismatch | missing ──(operator review + reason)──▶ overridden
```

Rules:
- Only the matcher, which runs server-side, may set `verified`. The driver app can never set it.
- Every transition writes a `verification_audit` row.
- A late authoritative event can still move a `missing` leg to `verified` or `mismatch`; the audit keeps both states.
- Matching uses the IVMS position from the source event, never the phone's position.

## Open questions for NWS

- The TAS interface: push or poll, the transaction ID format, and whether the volume is metered.
- IVMS: which vendors, message format, and the latency and signing guarantees.
- The tolerances for time window and volume, and who sets them.
- Who may override, and what reasons are acceptable.
