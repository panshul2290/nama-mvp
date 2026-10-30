"use client";

// Starts push in the customer or driver app (lib/push.ts): a tapped notification opens its screen.
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { startPush } from "./push";

export function usePushBridge(app: "customer" | "driver", signedIn: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!signedIn) return;
    startPush(app, (route) => router.push(route)).catch((e) => console.warn("[push] not started:", e));
  }, [app, signedIn, router]);
}
