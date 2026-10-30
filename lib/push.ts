// Push notifications in the customer and driver apps (E13), through @capacitor/push-notifications.
// Android needs Firebase (google-services.json) and iOS an APNs-enabled build; without them
// scripts/build-mobile.mjs leaves NEXT_PUBLIC_PUSH_ANDROID / NEXT_PUBLIC_PUSH_IOS unset, and this
// module skips registration (calling register() on Android without Firebase crashes the app) and
// logs that once. In-app notifications (the notifications table, realtime) work either way.
// Setup: docs/push.md.
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { isMissing } from "./rpcCompat";
import { supabase } from "./supabase/client";

type Platform = "android" | "ios";
const CONFIGURED: Record<Platform, boolean> = {
  android: process.env.NEXT_PUBLIC_PUSH_ANDROID === "true",
  ios: process.env.NEXT_PUBLIC_PUSH_IOS === "true",
};
const ASKED_KEY = "nama.push.asked";
const TOKEN_KEY = "nama.push.token";

let logged = false;
const logOnce = (msg: string) => {
  if (logged) return;
  logged = true;
  console.info(`[push] ${msg}`);
};

const platform = (): Platform | null => {
  const p = Capacitor.getPlatform();
  return p === "android" || p === "ios" ? p : null;
};

/** Push can be used on this device and build. */
export function pushAvailable(): boolean {
  const p = platform();
  if (!p || !Capacitor.isPluginAvailable("PushNotifications")) return false;
  if (!CONFIGURED[p]) {
    logOnce(`not configured for ${p} in this build (see docs/push.md); in-app notifications only`);
    return false;
  }
  return true;
}

import { pushRoute, type PushData } from "./pushRoute";

export { pushRoute };

let started = false;
const handles: PluginListenerHandle[] = [];

/**
 * Listen for taps and tokens. Safe to call more than once; does nothing in a browser or an
 * unconfigured build. Registration (and the permission prompt) happens in askPush().
 */
export async function startPush(app: "customer" | "driver", open: (route: string) => void): Promise<void> {
  if (started || !pushAvailable()) return;
  started = true;
  const { PushNotifications } = await import("@capacitor/push-notifications");
  handles.push(
    await PushNotifications.addListener("registration", async (t) => {
      // register_push_token(p_token, p_platform, p_app) (0026).
      try {
        localStorage.setItem(TOKEN_KEY, t.value);
      } catch {
        /* storage unavailable */
      }
      const { error } = await supabase().rpc("register_push_token", { p_token: t.value, p_platform: platform(), p_app: app });
      if (error && isMissing(error)) logOnce("register_push_token isn't in this database yet; token not stored");
      else if (error) console.warn("[push] token not stored:", error.message);
    }),
    await PushNotifications.addListener("registrationError", (e) => logOnce(`registration failed: ${e.error}`)),
    await PushNotifications.addListener("pushNotificationActionPerformed", (a) => open(pushRoute(app, a.notification.data as PushData))),
  );
  if (platform() === "android") {
    await PushNotifications.createChannel({ id: "orders", name: app === "customer" ? "Orders · الطلبات" : "Jobs · المهام", importance: 4, visibility: 1 }).catch(() => undefined);
  }
  // Already allowed earlier: register straight away (tokens can change between launches).
  const perm = await PushNotifications.checkPermissions();
  if (perm.receive === "granted") await PushNotifications.register().catch(() => undefined);
}

/**
 * Ask for permission at a moment that explains itself (an order placed, going online, the push
 * switch in Account) and register. Asks once per device unless `force`; resolves to whether push is on.
 */
export async function askPush(force = false): Promise<boolean> {
  if (!pushAvailable()) return false;
  const { PushNotifications } = await import("@capacitor/push-notifications");
  let perm = await PushNotifications.checkPermissions();
  if (perm.receive !== "granted") {
    let asked = false;
    try {
      asked = localStorage.getItem(ASKED_KEY) === "1";
    } catch {
      /* storage unavailable */
    }
    if (asked && !force) return false;
    try {
      localStorage.setItem(ASKED_KEY, "1");
    } catch {
      /* storage unavailable */
    }
    perm = await PushNotifications.requestPermissions();
  }
  if (perm.receive !== "granted") return false;
  await PushNotifications.register().catch(() => undefined);
  return true;
}

/**
 * Android 13+: the permission to show notifications, which the driver's "Sharing location — on
 * shift" notification also needs. Works without Firebase (it never registers). Asked once.
 */
export async function askNotificationPermission(): Promise<void> {
  if (platform() !== "android" || !Capacitor.isPluginAvailable("PushNotifications")) return;
  const { PushNotifications } = await import("@capacitor/push-notifications");
  const perm = await PushNotifications.checkPermissions();
  if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") await PushNotifications.requestPermissions();
}

/**
 * Before signing out: revoke this device's token (unregister_push_token, 0026), so the next
 * account on the phone doesn't get the previous one's notifications. Never throws.
 */
export async function unregisterPush(): Promise<void> {
  // The next sign-in on this phone starts push again (and registers the token for that account).
  started = false;
  await Promise.all(handles.splice(0).map((h) => h.remove().catch(() => undefined)));
  let token: string | null = null;
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
  if (!token) return;
  try {
    const { error } = await supabase().rpc("unregister_push_token", { p_token: token });
    if (error && !isMissing(error)) console.warn("[push] token not revoked:", error.message);
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* offline: the server revokes stale tokens when a send fails */
  }
}
