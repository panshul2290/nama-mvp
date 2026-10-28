// Builds an Android app (debug APK) for the customer or driver app:
//   1. stages a copy of the Next.js app without the desktop portals and server-only
//      routes, as a static export (output: 'export') — the APK contains the app;
//   2. syncs it into the Capacitor Android project in mobile/<app>/;
//   3. runs Gradle (assembleDebug) and copies the APK to dist/.
// Usage: node --env-file-if-exists=.env.local scripts/build-mobile.mjs customer|driver [--no-gradle]
// Needs JAVA_HOME (JDK 21) and ANDROID_HOME, or the defaults under ~/android-build.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const APPS = {
  customer: { id: "om.nama.tanker.customer", name: "Nama Tanker", drop: ["app/driver", "app/onboarding"] },
  driver: { id: "om.nama.tanker.driver", name: "Nama Driver", drop: ["app/customer"] },
};
const app = process.argv[2];
if (!APPS[app]) {
  console.error("Usage: build-mobile.mjs customer|driver [--no-gradle]");
  process.exit(1);
}
const gradle = !process.argv.includes("--no-gradle");
const root = resolve(".");
const stage = join(root, ".mobile", app);
const project = join(root, "mobile", app);

const run = (cmd, args, opts = {}) => {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ""} failed (exit ${r.status})`);
};

// ---- 1. stage and export ------------------------------------------------------
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ["app", "components", "lib", "public", "tsconfig.json", "package.json", "next-env.d.ts"]) {
  if (existsSync(f)) cpSync(f, join(stage, f), { recursive: true });
}
symlinkSync(join(root, "node_modules"), join(stage, "node_modules"), "junction");
// Desktop portals, the email-link callback (a route handler) and the session proxy can't be exported.
for (const p of ["app/nws", "app/company", "app/business", "app/auth", ...APPS[app].drop]) rmSync(join(stage, p), { recursive: true, force: true });

// The app opens on its own home: signed-in users go to their role's screens, others to sign-in.
writeFileSync(
  join(stage, "app", "page.tsx"),
  `"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Loading } from "@/components/Shell";
import { supabase } from "@/lib/supabase/client";

const APP = ${JSON.stringify(app)};

// Mobile build: route by role; a user of the other app is told which app to use.
export default function MobileHome() {
  const router = useRouter();
  const [wrong, setWrong] = useState<string | null>(null);
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
      await db.auth.signOut();
      setWrong(profile?.role === "driver" ? "the Nama Driver app" : profile?.role === "customer" ? "the Nama Tanker app" : "the web portal");
    })();
  }, [router]);
  if (wrong)
    return (
      <div className="screen" style={{ padding: 24 }}>
        <h2>Wrong app for this account</h2>
        <p className="mut">This account belongs in {wrong}. You've been signed out.</p>
        <button className="cta" onClick={() => router.replace("/login?app=" + APP)}>Sign in with another account</button>
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
const env = { ...process.env, NEXT_PUBLIC_APP_TARGET: app, NEXT_PUBLIC_DEMO_MODE: process.env.NEXT_PUBLIC_DEMO_MODE ?? "true", NEXT_TELEMETRY_DISABLED: "1" };
run("npx", ["next", "build"], { cwd: stage, env });

// ---- 2. Capacitor -----------------------------------------------------------------
mkdirSync(project, { recursive: true });
rmSync(join(project, "www"), { recursive: true, force: true });
cpSync(join(stage, "out"), join(project, "www"), { recursive: true });
writeFileSync(
  join(project, "capacitor.config.json"),
  JSON.stringify(
    {
      appId: APPS[app].id,
      appName: APPS[app].name,
      webDir: "www",
      android: { allowMixedContent: false, captureInput: true },
      plugins: {},
    },
    null,
    2,
  ) + "\n",
);
if (!existsSync(join(project, "android"))) run("npx", ["cap", "add", "android"], { cwd: project });
run("npx", ["cap", "sync", "android"], { cwd: project });
patchManifest(join(project, "android", "app", "src", "main", "AndroidManifest.xml"));

// ---- 3. Gradle --------------------------------------------------------------------
if (gradle) {
  const javaHome = process.env.JAVA_HOME || join(homedir(), "android-build", "jdk-21");
  const sdk = process.env.ANDROID_HOME || join(homedir(), "android-build", "sdk");
  writeFileSync(join(project, "android", "local.properties"), `sdk.dir=${sdk.replace(/\\/g, "\\\\")}\n`);
  run(process.platform === "win32" ? "gradlew.bat" : "./gradlew", ["assembleDebug", "--no-daemon"], {
    cwd: join(project, "android"),
    env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
  });
  mkdirSync("dist", { recursive: true });
  const apk = join(project, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  const outApk = join("dist", `nama-${app}-debug.apk`);
  cpSync(apk, outApk);
  console.log(`\nAPK: ${resolve(outApk)}`);
}

// Location (incl. background for the driver), camera for proof of delivery, notifications.
function patchManifest(path) {
  let xml = readFileSync(path, "utf8");
  const perms = [
    "android.permission.INTERNET",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.CAMERA",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.WAKE_LOCK",
    ...(app === "driver"
      ? ["android.permission.ACCESS_BACKGROUND_LOCATION", "android.permission.FOREGROUND_SERVICE", "android.permission.FOREGROUND_SERVICE_LOCATION"]
      : []),
  ];
  for (const p of perms) {
    if (!xml.includes(`"${p}"`)) xml = xml.replace("</manifest>", `    <uses-permission android:name="${p}" />\n</manifest>`);
  }
  writeFileSync(path, xml);
}
