// Driver location during an online shift or a job (C1). In the Android/iOS app it runs through
// @capacitor-community/background-geolocation, which starts a foreground service with a
// persistent notification ("Sharing location — on shift"), so fixes keep arriving with the app
// in the background or the screen off. In a browser it falls back to watchPosition
// (lib/geo-source.ts), which only works while the page is visible.
import { Capacitor, registerPlugin } from "@capacitor/core";
import type { BackgroundGeolocationPlugin } from "@capacitor-community/background-geolocation";
import { watchPosition, type GeoError, type GeoOptions } from "./geo-source";
import type { Fix } from "./tracking";

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>("BackgroundGeolocation");

/** True when fixes keep coming with the app in the background (native app with the plugin). */
export const backgroundCapable = (): boolean => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("BackgroundGeolocation");

/** The notification shown while sharing (localised by the caller). */
export type ShiftNotice = { title: string; message: string };

export function watchShiftPosition(onFix: (f: Fix) => void, onError: (e: GeoError) => void, notice: ShiftNotice, opts?: GeoOptions): () => void {
  if (!backgroundCapable()) return watchPosition(onFix, onError, opts);
  let id: string | null = null;
  let stopped = false;
  BackgroundGeolocation.addWatcher(
    // backgroundMessage set = the plugin runs a foreground service with this notification.
    { backgroundTitle: notice.title, backgroundMessage: notice.message, requestPermissions: true, stale: false, distanceFilter: 0 },
    (loc, err) => {
      if (err) {
        if (err.code === "NOT_AUTHORIZED") onError({ denied: true, message: err.message });
        else onError({ denied: false, message: err.message });
        return;
      }
      if (loc) onFix({ lat: loc.latitude, lng: loc.longitude, accuracy: loc.accuracy, at: loc.time ?? Date.now() });
    },
  )
    .then((w) => {
      id = w;
      if (stopped) BackgroundGeolocation.removeWatcher({ id: w }).catch(() => undefined);
    })
    .catch((e: unknown) => onError({ denied: false, message: String((e as { message?: string })?.message ?? e) }));
  return () => {
    stopped = true;
    if (id) BackgroundGeolocation.removeWatcher({ id }).catch(() => undefined);
  };
}

/** Open the app's settings (e.g. after location was refused). No-op in a browser. */
export function openLocationSettings(): void {
  if (backgroundCapable()) BackgroundGeolocation.openSettings().catch(() => undefined);
}

/**
 * Send one fix from the native app through the native HTTP stack (CapacitorHttp). Android
 * throttles requests made by a WebView that has been in the background for ~5 minutes; the
 * native request keeps a screen-off shift reporting. Same RPC and rules as supabase.rpc().
 */
export async function postFixNative(url: string, apiKey: string, token: string, args: Record<string, unknown>): Promise<{ error: { code?: string; message: string } | null }> {
  const { CapacitorHttp } = await import("@capacitor/core");
  try {
    const res = await CapacitorHttp.post({
      url: `${url.replace(/\/$/, "")}/rest/v1/rpc/report_location`,
      headers: { apikey: apiKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: args,
    });
    if (res.status >= 200 && res.status < 300) return { error: null };
    const body = (typeof res.data === "string" ? safeJson(res.data) : res.data) as { code?: string; message?: string } | null;
    return { error: { code: body?.code, message: body?.message ?? `HTTP ${res.status}` } };
  } catch (e) {
    return { error: { message: String((e as { message?: string })?.message ?? e) } };
  }
}

const safeJson = (s: string) => {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
};
