"use client";

import { useEffect, useState } from "react";
import type { PricingRule, PricingRules } from "@/lib/pricing";
import { supabase } from "@/lib/supabase/client";

let cache: Promise<PricingRules> | null = null;

function load(): Promise<PricingRules> {
  cache ??= Promise.resolve(supabase().from("pricing_rules").select("rule_key, value, status, source, notes")).then(({ data, error }) => {
    if (error) {
      cache = null;
      throw error;
    }
    return Object.fromEntries(((data ?? []) as PricingRule[]).map((r) => [r.rule_key, r]));
  });
  return cache;
}

/** The pricing rules table, fetched once per page load. */
export function usePricingRules(): { rules: PricingRules | null; error: string | null } {
  const [rules, setRules] = useState<PricingRules | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    load().then(setRules, (e: Error) => setError(e.message));
  }, []);
  return { rules, error };
}
