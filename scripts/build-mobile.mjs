// Builds the customer or driver app for Android (debug APK) or iOS (Xcode project):
//   1. stages a copy of the Next.js app without the desktop portals and server-only
//      routes, as a static export (output: 'export') — the app contains it;
//   2. syncs it into the Capacitor project in mobile/<app>/ (android/ or ios/) and patches the
//      native files a regenerated project would lose (permissions, Info.plist, AppDelegate);
//   3. Android: runs Gradle (assembleDebug) and copies the APK to dist/.
//      iOS: stops after `cap sync ios`; build and sign on a Mac (docs/ios.md).
// Usage: node --env-file-if-exists=.env.local scripts/build-mobile.mjs customer|driver [android|ios] [--demo] [--no-gradle] [--no-export]
// --demo (or BUILD_DEMO=1) builds the demo app with the driver's trip simulator (npm run
// build:apk:<app>:demo). Without it the build is non-demo: NEXT_PUBLIC_DEMO_MODE from
// .env.local (meant for the web dev server) is ignored, so no simulated GPS ships by accident.
// Android needs JAVA_HOME (JDK 21) and ANDROID_HOME, or the defaults under ~/android-build.
// Push (docs/push.md): Firebase's google-services.json in mobile/<app>/ enables Android push;
// NAMA_IOS_PUSH=1 once the iOS app has the Push Notifications capability.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const APPS = {
  customer: { id: "om.nama.tanker.customer", name: "Nama Tanker", drop: ["app/driver", "app/onboarding"] },
  driver: { id: "om.nama.tanker.driver", name: "Nama Driver", drop: ["app/customer"] },
};
const app = process.argv[2];
const platform = process.argv.includes("ios") ? "ios" : "android";
if (!APPS[app]) {
  console.error("Usage: build-mobile.mjs customer|driver [android|ios] [--demo] [--no-gradle] [--no-export]");
  process.exit(1);
}
const gradle = !process.argv.includes("--no-gradle");
const demo = process.argv.includes("--demo") || process.env.BUILD_DEMO === "1";
console.log(demo ? "(demo) DEMO build: the driver's Simulate trip is on — not for release" : "(release) non-demo build: no trip simulator");
// --no-export: reuse mobile/<app>/www from the last build (e.g. to generate the iOS project on Windows).
const exportWeb = !process.argv.includes("--no-export");
const root = resolve(".");
const stage = join(root, ".mobile", app);
const project = join(root, "mobile", app);
// Firebase files live next to the native projects (gitignored), so a regenerated android/ or
// ios/ folder gets them back on the next build.
const googleServices = join(project, "google-services.json");
const googleServicesPlist = join(project, "GoogleService-Info.plist");
const pushAndroid = existsSync(googleServices);
const pushIos = process.env.NAMA_IOS_PUSH === "1";

const run = (cmd, args, opts = {}) => {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ""} failed (exit ${r.status})`);
};

// ---- 1. stage and export (block body left unindented: it writes file templates verbatim) ----
if (exportWeb) {
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ["app", "components", "lib", "public", "tsconfig.json", "package.json", "next-env.d.ts"]) {
  if (existsSync(f)) cpSync(f, join(stage, f), { recursive: true });
}
symlinkSync(join(root, "node_modules"), join(stage, "node_modules"), "junction");
// Desktop portals, route handlers (the email-link callback, the /api/v1 integration API) and the session proxy can't be exported.
for (const p of ["app/nws", "app/company", "app/business", "app/auth", "app/api", "lib/api", ...APPS[app].drop]) rmSync(join(stage, p), { recursive: true, force: true });

// The app opens on its own home: signed-in users go to their screens, others to sign-in.
// The APK is one app (NEXT_PUBLIC_APP_TARGET): lib/supabase/client.ts keeps its session
// under that app's own cookie name, and its sign-in admits only that app's accounts.
writeFileSync(
  join(stage, "app", "page.tsx"),
  `"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AUTH } from "@/components/portal/authI18n";
import { signOutApp } from "@/components/portal/session";
import { WrongAccount } from "@/components/portal/WrongAccount";
import { Loading } from "@/components/Shell";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase/client";
import type { Role } from "@/lib/types";

const APP: string = ${JSON.stringify(app)};

// Mobile build: open the app; an account of another kind (signed in before this build) is signed out.
export default function MobileHome() {
  const router = useRouter();
  const t = useT(AUTH);
  const [wrong, setWrong] = useState<Role | null | undefined>(undefined);
  useEffect(() => {
    (async () => {
      const db = supabase();
      const { data: auth } = await db.auth.getUser();
      if (!auth.user) return router.replace("/login?app=" + APP);
      const { data: profile } = await db.from("profiles").select("role").eq("id", auth.user.id).single();
      if (APP === "customer" && profile?.role === "customer") return router.replace("/customer");
      if (APP === "driver" && profile?.role === "driver") {
        const { data: tanker } = await db.from("tankers").select("id").maybeSingle();
        return router.replace(tanker ? "/driver" : "/onboarding");
      }
      await signOutApp();
      setWrong((profile?.role ?? null) as Role | null);
    })();
  }, [router]);
  if (wrong !== undefined)
    return (
      <div className="screen" style={{ padding: 24 }}>
        <WrongAccount role={wrong} desktop={false} />
        <button className="cta" onClick={() => router.replace("/login?app=" + APP)}>{t("signIn")}</button>
      </div>
    );
  return <Loading />;
}
`,
);
writeFileSync(
  join(stage, "next.config.ts"),
  `import type { NextConfig } from "next";

// Static export for the ${app} Android app (scripts/build-mobile.mjs).
const nextConfig: NextConfig = { output: "export", trailingSlash: true, images: { unoptimized: true } };

export default nextConfig;
`,
);
const env = {
  ...process.env,
  NEXT_PUBLIC_APP_TARGET: app,
  NEXT_PUBLIC_DEMO_MODE: demo ? "true" : "false",
  // lib/push.ts registers for push only where it is configured; elsewhere it logs once and skips
  // (register() without Firebase would crash the Android app).
  NEXT_PUBLIC_PUSH_ANDROID: String(pushAndroid),
  NEXT_PUBLIC_PUSH_IOS: String(pushIos),
  NEXT_TELEMETRY_DISABLED: "1",
};
if (!pushAndroid) console.log(`(push) no ${googleServices}: the Android app is built without push (docs/push.md)`);
// Webpack follows the node_modules junction; Turbopack refuses files outside the staging root.
run("npx", ["next", "build", "--webpack"], { cwd: stage, env });
}

// ---- 2. Capacitor -----------------------------------------------------------------
mkdirSync(project, { recursive: true });
if (exportWeb) {
  rmSync(join(project, "www"), { recursive: true, force: true });
  cpSync(join(stage, "out"), join(project, "www"), { recursive: true });
} else if (!existsSync(join(project, "www"))) throw new Error(`--no-export needs a previous build in ${join(project, "www")}`);
writeFileSync(
  join(project, "capacitor.config.json"),
  JSON.stringify(
    {
      appId: APPS[app].id,
      appName: APPS[app].name,
      webDir: "www",
      // Driver: the legacy bridge keeps background location updates flowing past ~5 minutes
      // (@capacitor-community/background-geolocation README).
      android: { allowMixedContent: false, captureInput: true, ...(app === "driver" ? { useLegacyBridge: true } : {}) },
      ios: { contentInset: "automatic" },
      // The WebView stays on the bundled app (its own origin); links elsewhere open outside it.
      server: { allowNavigation: [] },
      plugins: { PushNotifications: { presentationOptions: ["badge", "sound", "alert"] } },
    },
    null,
    2,
  ) + "\n",
);
// Capacitor runs from an npm package root and finds native plugins in its dependencies
// (resolved from the repo's node_modules), so mirror the repo's Capacitor versions.
const rootPkg = JSON.parse(readFileSync("package.json", "utf8"));
const deps = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
const capDeps = Object.fromEntries(Object.entries(deps).filter(([k]) => k.startsWith("@capacitor")));
writeFileSync(join(project, "package.json"), JSON.stringify({ name: `nama-${app}-android`, private: true, dependencies: capDeps }, null, 2) + "\n");
if (platform === "ios") {
  // Capacitor 8 generates iOS projects with Swift Package Manager: no CocoaPods needed to create
  // or sync them, but building and signing needs Xcode on a Mac (docs/ios.md).
  if (!existsSync(join(project, "ios"))) run("npx", ["cap", "add", "ios", "--packagemanager", "SPM"], { cwd: project });
  run("npx", ["cap", "sync", "ios"], { cwd: project });
  patchIos(join(project, "ios", "App", "App"));
  console.log(`\niOS project: ${join(project, "ios", "App")} — open it in Xcode on a Mac to build and sign (docs/ios.md).`);
  process.exit(0);
}
if (!existsSync(join(project, "android"))) run("npx", ["cap", "add", "android"], { cwd: project });
run("npx", ["cap", "sync", "android"], { cwd: project });
patchManifest(join(project, "android", "app", "src", "main", "AndroidManifest.xml"));
patchCordovaConfig(join(project, "android", "app", "src", "main", "res", "xml", "config.xml"));
patchGradle(join(project, "android", "app", "build.gradle"));
// app/build.gradle applies the google-services plugin only when this file is there.
const gsTarget = join(project, "android", "app", "google-services.json");
if (pushAndroid) cpSync(googleServices, gsTarget);
else rmSync(gsTarget, { force: true });

// ---- 3. Gradle --------------------------------------------------------------------
if (gradle) {
  const javaHome = process.env.JAVA_HOME || join(homedir(), "android-build", "jdk-21");
  const sdk = process.env.ANDROID_HOME || join(homedir(), "android-build", "sdk");
  writeFileSync(join(project, "android", "local.properties"), `sdk.dir=${sdk.replace(/\\/g, "\\\\")}\n`);
  run(join(project, "android", process.platform === "win32" ? "gradlew.bat" : "gradlew"), ["assembleDebug", "--no-daemon"], {
    cwd: join(project, "android"),
    env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
  });
  mkdirSync("dist", { recursive: true });
  const apk = join(project, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  const outApk = join("dist", `nama-${app}${demo ? "-demo" : ""}-debug.apk`);
  cpSync(apk, outApk);
  console.log(`\nAPK: ${resolve(outApk)}`);
}

// iOS: usage descriptions (English in Info.plist and en.lproj, Arabic in ar.lproj/InfoPlist.strings),
// background modes (location for the driver's shift, remote notifications) and the AppDelegate
// hooks @capacitor/push-notifications needs. Re-applied on every iOS build.
function patchIos(dir) {
  const driver = app === "driver";
  const TEXT = {
    NSCameraUsageDescription: driver
      ? ["Take proof-of-delivery photos and photos of your documents.", "لالتقاط صور إثبات التسليم وصور مستنداتك."]
      : ["Take a photo of your ID card and of problems with a delivery.", "لالتقاط صورة لبطاقة هويتك وللمشكلات في التوصيل."],
    NSPhotoLibraryUsageDescription: driver
      ? ["Choose proof-of-delivery and document photos from your library.", "لاختيار صور إثبات التسليم والمستندات من مكتبتك."]
      : ["Choose a photo of your ID card or of a delivery problem.", "لاختيار صورة لبطاقة هويتك أو لمشكلة في التوصيل."],
    NSPhotoLibraryAddUsageDescription: ["Save the photos you take in the app.", "لحفظ الصور التي تلتقطها في التطبيق."],
    NSLocationWhenInUseUsageDescription: driver
      ? ["Share your tanker's location with NWS and your customer while you're online.", "لمشاركة موقع صهريجك مع نماء وعميلك أثناء اتصالك."]
      : ["Find your delivery location on the map.", "لتحديد موقع التوصيل على الخريطة."],
    NSLocationAlwaysAndWhenInUseUsageDescription: driver
      ? ["Keep sharing your location during a shift or a job while the app is in the background or the screen is off.", "لمواصلة مشاركة موقعك خلال المناوبة أو المهمة والتطبيق في الخلفية أو الشاشة مطفأة."]
      : ["Find your delivery location on the map.", "لتحديد موقع التوصيل على الخريطة."],
    NSUserNotificationsUsageDescription: driver
      ? ["Tell you about new jobs, messages and permit updates.", "لإعلامك بالمهام الجديدة والرسائل وتحديثات التصاريح."]
      : ["Tell you when your tanker is on the way, arrives and delivers.", "لإعلامك عندما يكون صهريجك في الطريق وعند وصوله وتسليمه."],
  };
  const NAME = { en: APPS[app].name, ar: driver ? "نماء للسائقين" : "نماء للصهاريج" };
  const esc = (v) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;");

  const plistPath = join(dir, "Info.plist");
  let plist = readFileSync(plistPath, "utf8");
  const setKey = (key, value) => {
    const old = new RegExp(`\\s*<key>${key}</key>\\s*(<string>[^<]*</string>|<array>[\\s\\S]*?</array>|<true/>|<false/>)`);
    plist = plist.replace(old, "");
    const end = plist.lastIndexOf("</dict>");
    plist = `${plist.slice(0, end)}\t<key>${key}</key>\n\t${value}\n${plist.slice(end)}`;
  };
  for (const [k, [en]] of Object.entries(TEXT)) setKey(k, `<string>${esc(en)}</string>`);
  setKey("CFBundleDisplayName", `<string>${esc(NAME.en)}</string>`);
  setKey("CFBundleDevelopmentRegion", "<string>en</string>");
  setKey("CFBundleLocalizations", "<array>\n\t\t<string>en</string>\n\t\t<string>ar</string>\n\t</array>");
  const modes = ["remote-notification", ...(driver ? ["location"] : [])];
  setKey("UIBackgroundModes", `<array>\n${modes.map((m) => `\t\t<string>${m}</string>`).join("\n")}\n\t</array>`);
  writeFileSync(plistPath, plist);

  for (const [lang, i] of [["en", 0], ["ar", 1]]) {
    mkdirSync(join(dir, `${lang}.lproj`), { recursive: true });
    const lines = [`"CFBundleDisplayName" = "${NAME[lang]}";`, ...Object.entries(TEXT).map(([k, v]) => `"${k}" = "${v[i].replace(/"/g, '\\"')}";`)];
    writeFileSync(join(dir, `${lang}.lproj`, "InfoPlist.strings"), lines.join("\n") + "\n");
  }

  // Bundle the two InfoPlist.strings as one localized resource (a variant group in the Xcode project).
  const pbxPath = join(dir, "..", "App.xcodeproj", "project.pbxproj");
  if (existsSync(pbxPath)) {
    let pbx = readFileSync(pbxPath, "utf8");
    if (!pbx.includes("/* InfoPlist.strings */")) {
      const ID = { group: "4E414D41000000000000A001", build: "4E414D41000000000000A002", en: "4E414D41000000000000A003", ar: "4E414D41000000000000A004" };
      const add = (marker, text) => {
        if (!pbx.includes(marker)) throw new Error(`project.pbxproj: "${marker}" not found`);
        pbx = pbx.replace(marker, marker + text);
      };
      add("/* Begin PBXBuildFile section */\n", `\t\t${ID.build} /* InfoPlist.strings in Resources */ = {isa = PBXBuildFile; fileRef = ${ID.group} /* InfoPlist.strings */; };\n`);
      add(
        "/* Begin PBXFileReference section */\n",
        `\t\t${ID.en} /* en */ = {isa = PBXFileReference; lastKnownFileType = text.plist.strings; name = en; path = en.lproj/InfoPlist.strings; sourceTree = "<group>"; };\n` +
          `\t\t${ID.ar} /* ar */ = {isa = PBXFileReference; lastKnownFileType = text.plist.strings; name = ar; path = ar.lproj/InfoPlist.strings; sourceTree = "<group>"; };\n`,
      );
      add(
        "/* Begin PBXVariantGroup section */\n",
        `\t\t${ID.group} /* InfoPlist.strings */ = {\n\t\t\tisa = PBXVariantGroup;\n\t\t\tchildren = (\n\t\t\t\t${ID.en} /* en */,\n\t\t\t\t${ID.ar} /* ar */,\n\t\t\t);\n\t\t\tname = InfoPlist.strings;\n\t\t\tsourceTree = "<group>";\n\t\t};\n`,
      );
      pbx = pbx.replace(/(\/\* App \*\/ = \{\s*isa = PBXGroup;\s*children = \(\n)/, `$1\t\t\t\t${ID.group} /* InfoPlist.strings */,\n`);
      pbx = pbx.replace(/(\/\* Resources \*\/ = \{\s*isa = PBXResourcesBuildPhase;\s*buildActionMask = \d+;\s*files = \(\n)/, `$1\t\t\t\t${ID.build} /* InfoPlist.strings in Resources */,\n`);
      if (!/knownRegions = \([^)]*\bar,/.test(pbx)) pbx = pbx.replace(/(knownRegions = \(\n)/, "$1\t\t\t\tar,\n");
      writeFileSync(pbxPath, pbx);
    }
  }

  // Push: hand the APNs token to @capacitor/push-notifications.
  const delegatePath = join(dir, "AppDelegate.swift");
  if (existsSync(delegatePath)) {
    let swift = readFileSync(delegatePath, "utf8");
    if (!swift.includes("capacitorDidRegisterForRemoteNotifications")) {
      const end = swift.lastIndexOf("}");
      swift = `${swift.slice(0, end).trimEnd()}

    // @capacitor/push-notifications (added by scripts/build-mobile.mjs)
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
}
`;
      writeFileSync(delegatePath, swift);
    }
  }
  if (existsSync(googleServicesPlist)) cpSync(googleServicesPlist, join(dir, "GoogleService-Info.plist"));
}

// Location (incl. background for the driver), camera and photos for proof of delivery
// (@capacitor/camera: live camera, and the gallery through the system photo picker), notifications.
// Re-applied on every build, so a regenerated android/ project keeps them.
function patchManifest(path) {
  let xml = readFileSync(path, "utf8");
  // No adb/cloud backup of the WebView storage (the Supabase refresh token) or app data.
  xml = xml.replace('android:allowBackup="true"', 'android:allowBackup="false"');
  const perms = [
    "android.permission.INTERNET",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.CAMERA",
    // Gallery: Android 13+ reads images with READ_MEDIA_IMAGES; older versions with READ_EXTERNAL_STORAGE.
    "android.permission.READ_MEDIA_IMAGES",
    ["android.permission.READ_EXTERNAL_STORAGE", 'android:maxSdkVersion="32"'],
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.WAKE_LOCK",
    ...(app === "driver"
      ? ["android.permission.ACCESS_BACKGROUND_LOCATION", "android.permission.FOREGROUND_SERVICE", "android.permission.FOREGROUND_SERVICE_LOCATION"]
      : []),
  ];
  for (const entry of perms) {
    const [p, attrs] = Array.isArray(entry) ? entry : [entry, ""];
    if (!xml.includes(`"${p}"`)) xml = xml.replace("</manifest>", `    <uses-permission android:name="${p}"${attrs ? ` ${attrs}` : ""} />\n</manifest>`);
  }
  // Android 11+ package visibility: let the app find the camera app and the image picker.
  if (!xml.includes("android.media.action.IMAGE_CAPTURE")) {
    xml = xml.replace(
      "</manifest>",
      `    <queries>\n        <intent>\n            <action android:name="android.media.action.IMAGE_CAPTURE" />\n        </intent>\n        <intent>\n            <action android:name="android.intent.action.GET_CONTENT" />\n            <data android:mimeType="image/*" />\n        </intent>\n    </queries>\n</manifest>`,
    );
  }
  writeFileSync(path, xml);
}

// cap sync writes the Cordova whitelist as <access origin="*" />. Capacitor itself doesn't use it
// and the app has no Cordova plugins; narrow it to the app's own origin anyway.
function patchCordovaConfig(path) {
  if (!existsSync(path)) return;
  const xml = readFileSync(path, "utf8").replace('<access origin="*" />', '<access origin="https://localhost" />');
  writeFileSync(path, xml);
}

// Release builds are shrunk and obfuscated with R8 (Capacitor ships consumer keep rules for its
// bridge and plugins; proguard-rules.pro adds the JavaScript interface). Debug APKs are unaffected.
function patchGradle(path) {
  const gradleText = readFileSync(path, "utf8").replace(
    /minifyEnabled false(\r?\n\s*)proguardFiles getDefaultProguardFile\('proguard-android\.txt'\)/,
    "minifyEnabled true$1proguardFiles getDefaultProguardFile('proguard-android-optimize.txt')",
  );
  writeFileSync(path, gradleText);
}
