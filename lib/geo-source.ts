// The one place the driver app touches device location and the screen wake lock.
// In a browser it wraps navigator.geolocation / navigator.wakeLock. In the Android
// app (Capacitor) location comes from a native background-location plugin with a
// foreground-service notification, so tracking continues with the screen off.
import { Capacitor, registerPlugin } from "@capacitor/core";
import type { BackgroundGeolocationPlugin } from "@capacitor-community/background-geolocation";
import type { Fix } from "./tracking";

export type GeoError = { denied: boolean; message: string };
export type GeoOptions = { highAccuracy?: boolean; maximumAgeMs?: number; timeoutMs?: number };

const native = () => Capacitor.isNativePlatform();
const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>("BackgroundGeolocation");

const hasGeo = () => native() || (typeof navigator !== "undefined" && "geolocation" in navigator);

const toFix = (p: GeolocationPosition): Fix => ({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: p.timestamp });
const toErr = (e: GeolocationPositionError): GeoError => ({ denied: e.code === e.PERMISSION_DENIED, message: e.message });
const toOpts = (o: GeoOptions = {}): PositionOptions => ({
  enableHighAccuracy: o.highAccuracy ?? true,
  maximumAge: o.maximumAgeMs ?? 5_000,
  timeout: o.timeoutMs ?? 20_000,
});

/** True when the device can give a location at all. */
export const geoAvailable = (): boolean => hasGeo();

/** Continuous fixes until the returned stop function is called. */
export function watchPosition(onFix: (f: Fix) => void, onError: (e: GeoError) => void, opts?: GeoOptions): () => void {
  if (!hasGeo()) {
    onError({ denied: false, message: "Location is not available on this device" });
    return () => {};
  }
  if (native()) {
    let id: string | null = null;
    let stopped = false;
    BackgroundGeolocation.addWatcher(
      { backgroundTitle: "Nama Driver — tracking on", backgroundMessage: "Sharing your location with NWS while you're online.", requestPermissions: true, stale: false, distanceFilter: 0 },
      (loc, err) => {
        if (err) return onError({ denied: err.code === "NOT_AUTHORIZED", message: err.message });
        if (loc) onFix({ lat: loc.latitude, lng: loc.longitude, accuracy: loc.accuracy, at: loc.time ?? Date.now() });
      },
    ).then((w) => {
      id = w;
      if (stopped) BackgroundGeolocation.removeWatcher({ id: w }).catch(() => undefined);
    });
    return () => {
      stopped = true;
      if (id) BackgroundGeolocation.removeWatcher({ id }).catch(() => undefined);
    };
  }
  const id = navigator.geolocation.watchPosition((p) => onFix(toFix(p)), (e) => onError(toErr(e)), toOpts(opts));
  return () => navigator.geolocation.clearWatch(id);
}

/** One fresh fix. Rejects with a GeoError. */
export function getCurrentPosition(opts?: GeoOptions): Promise<Fix> {
  if (!hasGeo()) return Promise.reject<Fix>({ denied: false, message: "Location is not available on this device" } satisfies GeoError);
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition((p) => resolve(toFix(p)), (e) => reject(toErr(e)), toOpts({ maximumAgeMs: 0, timeoutMs: 9_000, ...opts })),
  );
}

/** Whether the screen can be kept on. */
export const wakeLockSupported = (): boolean => native() || (typeof navigator !== "undefined" && "wakeLock" in navigator);

/**
 * Keep the screen on. Resolves to a release function; `onLost` fires if the
 * system drops the lock (e.g. the page was hidden). Rejects when refused.
 */
export async function keepScreenOn(onLost: () => void): Promise<() => Promise<void>> {
  if (!wakeLockSupported()) throw new Error("unsupported");
  // Native: the foreground location service keeps tracking with the screen off.
  if (native() && !("wakeLock" in navigator)) return async () => {};
  const lock = await navigator.wakeLock.request("screen");
  let released = false;
  lock.addEventListener("release", () => !released && onLost());
  return async () => {
    released = true;
    await lock.release().catch(() => undefined);
  };
}
