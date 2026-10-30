"use client";

import { useCallback, useState } from "react";
import { tankerOf, useFleet } from "@/components/company/CompanyContext";
import { CO } from "@/components/company/i18n";
import { useFmt } from "@/components/portal/i18n";
import { St, useAction, useLive } from "@/components/portal/kit";
import { useT } from "@/lib/i18n";
import { SHIFT_KEYS, shiftHours, type Shift } from "@/lib/shifts";
import { supabase } from "@/lib/supabase/client";
import { omanToday, omanWeekday } from "@/lib/time";

type Avail = { driver_id: string; weekday: number; available: boolean; shift: Shift; start_time?: string | null; end_time?: string | null };
type Emergency = { on: boolean; zone: string | null; reason: string | null };

// Weekdays 0 (Sunday) to 6 and shift names are CO keys (d0…d6, sh_day…), translated at render.
const DAYS = ["d0", "d1", "d2", "d3", "d4", "d5", "d6"];

// Today's weekday in Muscat (0 = Sunday), as the database stores it.
const muscatWeekday = () => omanWeekday();

export default function CompanyShifts() {
  const fleet = useFleet("shifts");
  const { busy, run } = useAction();
  const [avail, setAvail] = useState<Avail[]>([]);
  const [until, setUntil] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Set<string>>(new Set());
  const [emergency, setEmergency] = useState<Emergency | null>(null);
  const t = useT(CO);
  const f = useFmt();
  const shiftName = (s: Shift) => t(`sh_${s}`);

  const load = useCallback(async () => {
    const db = supabase();
    const today = omanToday();
    const [a, u, s, e] = await Promise.all([
      db.from("driver_availability").select("driver_id, weekday, available, shift, start_time, end_time"),
      db.from("driver_profiles").select("driver_id, unavailable_until"),
      db.from("shift_checks").select("driver_id").eq("day", today),
      db.from("app_settings").select("value").eq("key", "EMERGENCY").maybeSingle(),
    ]);
    setAvail((a.data ?? []) as Avail[]);
    setUntil(Object.fromEntries(((u.data ?? []) as { driver_id: string; unavailable_until: string | null }[]).filter((r) => r.unavailable_until).map((r) => [r.driver_id, r.unavailable_until as string])));
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
        {t("availTitle")} <small>{t("availSub")}</small>
      </h2>
      <div className="pad">
        {emergency?.on && (
          <div className="banner badb">
            <b>{emergency.zone ? t("emBIn", { zone: emergency.zone }) : t("emB")}</b> {t("emBody")}
            {emergency.reason ? ` ${t("emReason", { r: emergency.reason })}` : ""}
          </div>
        )}
        <div className="grid-week">
          <div />
          {DAYS.map((d, i) => (
            <div key={d} className={`h ${i === today ? "today" : ""}`}>
              {t(d)}
              {i === today ? t("todaySfx") : ""}
            </div>
          ))}
          {fleet.drivers.map((d) => {
            const tk = tankerOf(fleet, d.id);
            return [
              <div className="l" key={`${d.id}-l`}>
                <b>{d.full_name}</b>
                <small>
                  {tk?.plate ?? t("noTanker")}
                  {checks.has(d.id) ? t("preTripDone") : ""}
                </small>
                {until[d.id] && until[d.id] > omanToday() && <small className="badt">{t("avUntil", { d: f.date(until[d.id]) })}</small>}
              </div>,
              ...DAYS.map((_, day) => {
                const a = get(d.id, day);
                const ovr = !!emergency?.on && day === today;
                const k = `${d.id}${day}`;
                return (
                  <div key={k} className={`shift ${ovr ? "ovr" : a.available ? "on" : ""}`}>
                    <button className="tg" disabled={busy === k} aria-pressed={a.available} onClick={() => save({ ...a, available: !a.available })} aria-label={t("avAria", { name: d.full_name, day: t(DAYS[day]), state: a.available ? t("avOn") : t("avOff") })}>
                      {ovr ? t("avNws") : a.available ? t("avOn") : t("avOff")}
                    </button>
                    <select aria-label={t("avShiftAria", { name: d.full_name, day: t(DAYS[day]) })} value={a.shift} disabled={!a.available || busy === k} onChange={(e) => save({ ...a, shift: e.target.value as Avail["shift"] })}>
                      {SHIFT_KEYS.map((s) => (
                        <option key={s} value={s}>
                          {shiftName(s)} {f.d(shiftHours(s, true))}
                        </option>
                      ))}
                    </select>
                    {a.available && a.start_time && a.end_time && (
                      <small dir="ltr">
                        {a.start_time.slice(0, 5)}–{a.end_time.slice(0, 5)}
                      </small>
                    )}
                  </div>
                );
              }),
            ];
          })}
        </div>
        {fleet.loaded && !fleet.drivers.length && <div className="empty">{t("shiftsEmpty")}</div>}
        <p className="mut" style={{ fontSize: 13, margin: "14px 0 0" }}>
          {fleet.drivers.length > 0 && (
            <>
              <St tone="ok">{t("onDutyN", { n: f.n(onDuty) })}</St>{" "}
            </>
          )}
          {t("shiftsNote", { list: SHIFT_KEYS.map((s) => `${shiftName(s)} ${f.d(shiftHours(s))}`).join(" · ") })} {t("avNote")}
        </p>
      </div>
    </div>
  );
}
