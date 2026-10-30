"use client";

import { useCallback, useState } from "react";
import { tankerOf, useFleet } from "@/components/company/CompanyContext";
import { St, useAction, useLive } from "@/components/portal/kit";
import { SHIFT_KEYS, shiftHours, type Shift } from "@/lib/shifts";
import { supabase } from "@/lib/supabase/client";
import { omanToday, omanWeekday } from "@/lib/time";

type Avail = { driver_id: string; weekday: number; available: boolean; shift: Shift };
type Emergency = { on: boolean; zone: string | null; reason: string | null };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHIFT_NAME: Record<Shift, string> = { day: "Day", evening: "Evening", night: "Night" };

// Today's weekday in Muscat (0 = Sunday), as the database stores it.
const muscatWeekday = () => omanWeekday();

export default function CompanyShifts() {
  const fleet = useFleet("shifts");
  const { busy, run } = useAction();
  const [avail, setAvail] = useState<Avail[]>([]);
  const [checks, setChecks] = useState<Set<string>>(new Set());
  const [emergency, setEmergency] = useState<Emergency | null>(null);

  const load = useCallback(async () => {
    const db = supabase();
    const today = omanToday();
    const [a, s, e] = await Promise.all([
      db.from("driver_availability").select("driver_id, weekday, available, shift"),
      db.from("shift_checks").select("driver_id").eq("day", today),
      db.from("app_settings").select("value").eq("key", "EMERGENCY").maybeSingle(),
    ]);
    setAvail((a.data ?? []) as Avail[]);
    setChecks(new Set((s.data ?? []).map((r: { driver_id: string }) => r.driver_id)));
    try {
      setEmergency(e.data?.value ? (JSON.parse(e.data.value) as Emergency) : null);
    } catch {
      setEmergency(null);
    }
  }, []);
  useLive("shifts", ["driver_availability", "shift_checks", "app_settings"], load);

  const today = muscatWeekday();
  // No row yet = the table defaults: available, day shift.
  const get = (driver: string, day: number): Avail => avail.find((a) => a.driver_id === driver && a.weekday === day) ?? { driver_id: driver, weekday: day, available: true, shift: "day" };

  async function save(next: Avail) {
    setAvail((all) => [...all.filter((a) => !(a.driver_id === next.driver_id && a.weekday === next.weekday)), next]);
    const ok = await run(`${next.driver_id}${next.weekday}`, () =>
      supabase().rpc("set_availability", { p_weekday: next.weekday, p_available: next.available, p_shift: next.shift, p_driver_id: next.driver_id }),
    );
    if (!ok) load();
  }

  const onDuty = fleet.drivers.filter((d) => get(d.id, today).available).length;

  return (
    <div className="panel">
      <h2>
        Driver availability <small>Tap a day to switch a driver on or off; choose the shift underneath</small>
      </h2>
      <div className="pad">
        {emergency?.on && (
          <div className="banner badb">
            <b>Emergency mode{emergency.zone ? ` in ${emergency.zone}` : ""}.</b> NWS has overridden today’s shifts — all drivers are on call.{emergency.reason ? ` Reason: ${emergency.reason}` : ""}
          </div>
        )}
        <div className="grid-week">
          <div />
          {DAYS.map((d, i) => (
            <div key={d} className={`h ${i === today ? "today" : ""}`}>
              {d}
              {i === today ? " · today" : ""}
            </div>
          ))}
          {fleet.drivers.map((d) => {
            const tk = tankerOf(fleet, d.id);
            return [
              <div className="l" key={`${d.id}-l`}>
                <b>{d.full_name}</b>
                <small>
                  {tk?.plate ?? "No tanker"}
                  {checks.has(d.id) ? " · pre-trip check done" : ""}
                </small>
              </div>,
              ...DAYS.map((_, day) => {
                const a = get(d.id, day);
                const ovr = !!emergency?.on && day === today;
                const k = `${d.id}${day}`;
                return (
                  <div key={k} className={`shift ${ovr ? "ovr" : a.available ? "on" : ""}`}>
                    <button className="tg" disabled={busy === k} aria-pressed={a.available} onClick={() => save({ ...a, available: !a.available })} aria-label={`${d.full_name}, ${DAYS[day]}: ${a.available ? "on" : "off"}`}>
                      {ovr ? "NWS" : a.available ? "On" : "Off"}
                    </button>
                    <select aria-label={`${d.full_name}, ${DAYS[day]} shift`} value={a.shift} disabled={!a.available || busy === k} onChange={(e) => save({ ...a, shift: e.target.value as Avail["shift"] })}>
                      {SHIFT_KEYS.map((s) => (
                        <option key={s} value={s}>
                          {SHIFT_NAME[s]} {shiftHours(s, true)}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              }),
            ];
          })}
        </div>
        {fleet.loaded && !fleet.drivers.length && <div className="empty">Add drivers first, then plan their week here.</div>}
        <p className="mut" style={{ fontSize: 13, margin: "14px 0 0" }}>
          {fleet.drivers.length > 0 && (
            <>
              <St tone="ok">{onDuty} on duty today</St>{" "}
            </>
          )}
          Shifts (Muscat time): {SHIFT_KEYS.map((s) => `${SHIFT_NAME[s]} ${shiftHours(s)}`).join(" · ")}. NWS can override shifts in emergency mode and call every driver on duty. Drivers see their week in the Driver app and can change it too.
        </p>
      </div>
    </div>
  );
}
