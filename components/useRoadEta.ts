"use client";

import { useEffect, useRef, useState } from "react";
import { routeEta, type RouteEta } from "@/lib/routing";
import type { LngLat } from "@/lib/types";

export const ETA_REFRESH_MS = 30_000;

/** Road ETA between two points, recalculated at most every 30 s. */
export function useRoadEta(from: LngLat | null, to: LngLat | null): RouteEta | null {
  const [eta, setEta] = useState<RouteEta | null>(null);
  const last = useRef(0);
  const inFlight = useRef(false);
  const latest = useRef({ from, to });
  useEffect(() => {
    latest.current = { from, to };
  });

  useEffect(() => {
    const run = () => {
      const { from: a, to: b } = latest.current;
      if (!a || !b || inFlight.current || Date.now() - last.current < ETA_REFRESH_MS) return;
      inFlight.current = true;
      last.current = Date.now();
      routeEta(a, b).then((r) => {
        inFlight.current = false;
        setEta(r);
      });
    };
    const first = setTimeout(run, 0);
    const timer = setInterval(run, 5_000); // checks often, but only calls the router every 30 s
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  return from && to ? eta : null;
}
