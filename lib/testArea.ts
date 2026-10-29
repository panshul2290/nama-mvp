"use client";

// Active test zones (0020, "Test – India"): their bounding boxes, read from the
// zones table and cached for a few minutes, so switching the test zone off in
// NWS Settings takes effect without a rebuild. The check runs on the device:
// no position is sent to the server.
import { useEffect, useState } from "react";
import { supabase } from "./supabase/client";
import type { LngLat } from "./types";

export type Bounds = { min_lat: number; max_lat: number; min_lng: number; max_lng: number };

const TTL_MS = 5 * 60_000;
let cache: { at: number; p: Promise<Bounds[]> } | null = null;

export function testAreas(): Promise<Bounds[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.p;
  const p = Promise.resolve(
    supabase().from("zones").select("min_lat, max_lat, min_lng, max_lng").eq("is_test", true).eq("active", true).not("min_lat", "is", null),
  ).then(({ data, error }) => {
    if (error) cache = null; // retry on the next call
    return (data ?? []) as Bounds[];
  }, () => {
    cache = null;
    return [] as Bounds[];
  });
  cache = { at: Date.now(), p };
  return p;
}

export const inTestArea = (p: LngLat, areas: Bounds[]) =>
  areas.some((b) => p.lat >= b.min_lat && p.lat <= b.max_lat && p.lng >= b.min_lng && p.lng <= b.max_lng);

/** The active test areas (empty until loaded, or when the test zone is off). */
export function useTestAreas(): Bounds[] {
  const [areas, setAreas] = useState<Bounds[]>([]);
  useEffect(() => {
    let live = true;
    testAreas().then((a) => live && setAreas(a));
    return () => {
      live = false;
    };
  }, []);
  return areas;
}
