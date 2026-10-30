// Photos for proof of delivery: the live camera or the gallery.
// In the Android app (Capacitor) the camera plugin opens the camera or the system photo picker
// itself; the WebView's own file chooser often can't open the camera there. In a browser a file
// input does the job ("capture" opens the camera on phones). Large photos are scaled down before
// upload so a weak connection can still send them.
import { Capacitor } from "@capacitor/core";

export type PhotoSource = "camera" | "gallery";
/** Why no photo came back: the person backed out, or the app may not use the camera / photos. */
export class PhotoError extends Error {
  constructor(readonly reason: "cancelled" | "denied" | "failed", message?: string) {
    super(message ?? reason);
  }
}

const MAX_EDGE = 1600; // px, long edge after scaling
const SCALE_ABOVE = 1_500_000; // bytes; smaller photos are uploaded as taken

/** The native camera plugin is used only inside the Android/iOS app and only when it is installed. */
export const nativeCamera = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("Camera");

/** Native app: take a photo or pick one from the gallery. Resolves to a File, or throws PhotoError. */
export async function nativePhoto(source: PhotoSource): Promise<File> {
  const { Camera, EncodingType, MediaTypeSelection } = await import("@capacitor/camera");
  try {
    const perm = await Camera.checkPermissions();
    const kind = source === "camera" ? "camera" : "photos";
    if (perm[kind] !== "granted" && perm[kind] !== "limited") {
      const asked = await Camera.requestPermissions({ permissions: [kind] });
      // The Android photo picker needs no permission; only a refused camera stops us.
      if (source === "camera" && asked.camera === "denied") throw new PhotoError("denied");
    }
    const res =
      source === "camera"
        ? await Camera.takePhoto({ quality: 80, targetWidth: MAX_EDGE, targetHeight: MAX_EDGE, correctOrientation: true, encodingType: EncodingType.JPEG, saveToGallery: false, editable: "no" })
        : (await Camera.chooseFromGallery({ mediaType: MediaTypeSelection.Photo, allowMultipleSelection: false, limit: 1, quality: 80, targetWidth: MAX_EDGE, targetHeight: MAX_EDGE, correctOrientation: true, editable: "no" })).results[0];
    const src = res?.webPath ?? res?.uri;
    if (!src) throw new PhotoError("cancelled");
    const blob = await (await fetch(src.startsWith("file:") ? Capacitor.convertFileSrc(src) : src)).blob();
    return new File([blob], `pod-${Date.now()}.jpg`, { type: blob.type || "image/jpeg" });
  } catch (e) {
    if (e instanceof PhotoError) throw e;
    const msg = String((e as { message?: string })?.message ?? e).toLowerCase();
    if (msg.includes("cancel")) throw new PhotoError("cancelled");
    if (msg.includes("denied") || msg.includes("permission")) throw new PhotoError("denied");
    throw new PhotoError("failed", msg);
  }
}

/** Scale a large photo down to MAX_EDGE as JPEG; returns the original when it is small or can't be decoded. */
export async function shrinkPhoto(file: File): Promise<File> {
  if (file.size <= SCALE_ABOVE || typeof createImageBitmap !== "function") return file;
  try {
    const img = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * k);
    canvas.height = Math.round(img.height * k);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    img.close();
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.82));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}
