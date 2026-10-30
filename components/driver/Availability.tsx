"use client";

// Part-time availability (0041): hours per weekday and "not available until". Dispatch and
// auto-offer skip the driver outside them; going online anyway is allowed, with a note.
import { useCallback, useEffect, useState } from "react";
import { useDriver } from "@/components/DriverContext";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import { DICT, useErrText } from "./i18n";

type Now = { available: boolean; note: string | null; unavailable_until: string | null };

/** The note on Home when the driver is online outside their hours. */
export function AvailabilityNote() {
  const { online } = useDriver();
  const t = useT(DICT);
  const [s, setS] = useState<Now | null>(null);
  useEffect(() => {
    if (!online) return;
    let live = true;
    supabase()
      .rpc("my_availability_now")
      .then(({ data }) => live && setS((data as Now) ?? null));
    return () => {
      live = false;
    };
  }, [online]);
  if (!online || !s || s.available) return null;
  return (
    <div className="banner" role="note">
      <b>{t("avOutsideT")}</b> {t("avOutsideS")}
    </div>
  );
}

type Day = { weekday: number; available: boolean; start_time: string | null; end_time: string | null };

/** Profile: hours per day and the "not available until" date. */
export function AvailabilityEditor() {
  const { profile, toast } = useDriver();
  const t = useT(DICT);
  const errText = useErrText();
  const [days, setDays] = useState<Day[]>([]);
  const [until, setUntil] = useState<string>("");
  const load = useCallback(async () => {
    const db = supabase();
    const [a, p] = await Promise.all([
      db.from("driver_availability").select("weekday, available, start_time, end_time").eq("driver_id", profile.id),
      db.from("driver_profiles").select("unavailable_until").eq("driver_id", profile.id).maybeSingle(),
    ]);
    setDays((a.data ?? []) as Day[]);
    setUntil((p.data as { unavailable_until: string | null } | null)?.unavailable_until ?? "");
  }, [profile.id]);
  useEffect(() => {
    const tm = setTimeout(load, 0);
    return () => clearTimeout(tm);
  }, [load]);

  const dayOf = (d: number): Day => days.find((x) => x.weekday === d) ?? { weekday: d, available: true, start_time: null, end_time: null };
  async function save(d: number, patch: Partial<Day>) {
    const next = { ...dayOf(d), ...patch };
    if ((next.start_time == null) !== (next.end_time == null)) {
      next.start_time = next.start_time ?? "08:00";
      next.end_time = next.end_time ?? "16:00";
    }
    setDays((all) => [...all.filter((x) => x.weekday !== d), next]);
    const { error } = await supabase().rpc("set_availability_hours", {
      p_weekday: d,
      p_available: next.available,
      p_start: next.start_time?.slice(0, 5) ?? null,
      p_end: next.end_time?.slice(0, 5) ?? null,
    });
    if (error) {
      toast(errText(error));
      load();
    }
  }
  async function saveUntil(v: string) {
    setUntil(v);
    const { error } = await supabase().rpc("set_unavailable_until", { p_date: v || null });
    if (error) {
      toast(errText(error));
      load();
    } else toast(v ? t("avUntilSet") : t("avUntilCleared"));
  }

  return (
    <div className="ch-list">
      {[0, 1, 2, 3, 4, 5, 6].map((d) => {
        const x = dayOf(d);
        const hours = x.start_time != null;
        return (
          <div key={d} className="lrow" style={{ flexWrap: "wrap", gap: 6 }}>
            <span>
              <b>{t(`wd${d}`)}</b>
              <small>{!x.available ? t("avOff") : hours ? `${x.start_time!.slice(0, 5)}–${x.end_time!.slice(0, 5)}` : t("avAllDay")}</small>
            </span>
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <label className="small">
                <input type="checkbox" checked={x.available} onChange={(e) => save(d, { available: e.target.checked })} /> {t("avOn")}
              </label>
              {x.available && (
                <>
                  <input
                    type="time"
                    aria-label={t("avFrom")}
                    value={x.start_time?.slice(0, 5) ?? ""}
                    onChange={(e) => save(d, { start_time: e.target.value || null, end_time: e.target.value ? (x.end_time ?? "16:00") : null })}
                  />
                  <input
                    type="time"
                    aria-label={t("avTo")}
                    value={x.end_time?.slice(0, 5) ?? ""}
                    onChange={(e) => save(d, { end_time: e.target.value || null, start_time: e.target.value ? (x.start_time ?? "08:00") : null })}
                  />
                </>
              )}
            </span>
          </div>
        );
      })}
      <div className="lrow">
        <span>
          <b>{t("avUntil")}</b>
          <small>{t("avUntilS")}</small>
        </span>
        <input type="date" aria-label={t("avUntil")} value={until} onChange={(e) => saveUntil(e.target.value)} />
      </div>
    </div>
  );
}
