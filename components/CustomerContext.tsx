"use client";

import { createContext, use } from "react";
import type { Profile } from "@/lib/types";

export const CustomerCtx = createContext<Profile | null>(null);

export function useCustomer(): Profile {
  const p = use(CustomerCtx);
  if (!p) throw new Error("useCustomer must be used inside the customer layout");
  return p;
}
