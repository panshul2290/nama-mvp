"use client";

import { useEffect, useState } from "react";

/** The current time, refreshed every `ms` (0 until mounted, so renders stay pure). */
export function useNow(ms = 1_000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, ms);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [ms]);
  return now;
}
