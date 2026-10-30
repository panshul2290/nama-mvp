# iOS apps (customer and driver)

**Status:** the Xcode projects are generated and committed under `mobile/customer/ios/` and `mobile/driver/ios/` (Capacitor 8.5.3, Swift Package Manager — no CocoaPods). They were generated on Windows with `cap add ios` / `cap sync ios`; **they have not been built or run on a Mac or iPhone yet**, so treat the first Xcode build as untested.

## What the build script does

```bash
node --env-file-if-exists=.env.local scripts/build-mobile.mjs customer ios
node --env-file-if-exists=.env.local scripts/build-mobile.mjs driver ios
```

1. Static export of the app (same as Android) into `mobile/<app>/www`.
2. `npx cap add ios --packagemanager SPM` the first time, then `npx cap sync ios` (copies the web app and writes `ios/App/CapApp-SPM/Package.swift` with the plugins: camera, push notifications, background geolocation).
3. Patches, on every run, so a regenerated project keeps them:
   - `Info.plist`: camera, photo library (read and add), location when in use, location always (driver: background shift tracking), notifications descriptions in English; display name; `CFBundleLocalizations` en + ar; `UIBackgroundModes` `remote-notification` (both) and `location` (driver).
   - `en.lproj/InfoPlist.strings` and `ar.lproj/InfoPlist.strings`: the same descriptions in English and Arabic, added to the Xcode project as a localized resource; `ar` added to the project's regions.
   - `AppDelegate.swift`: forwards the APNs token to `@capacitor/push-notifications`.

`--no-export` reuses the last `mobile/<app>/www` (that is how the committed projects were generated on Windows without running `next build`).

## Building on a Mac

Needs macOS with Xcode 16+ (iOS 15+ deployment target) and Node 20+.

1. `git clone`, `npm install` (the SPM package paths point into the repo's `node_modules/`).
2. Fill `.env.local` (Supabase URL and publishable key), then run the build script above for each app.
3. `open mobile/<app>/ios/App/App.xcodeproj`. Xcode resolves the Swift packages on first open.
4. **Signing & Capabilities:** choose the team (needs an Apple Developer account, USD 99/year, ideally NWS's or the vendor's organisation account), keep the bundle ids `om.nama.tanker.customer` / `om.nama.tanker.driver`.
5. Driver app: add **Background Modes → Location updates** (already in `Info.plist`; Xcode shows it ticked).
6. Push: see `docs/push.md` (Push Notifications capability, APNs key, `NAMA_IOS_PUSH=1`).
7. Run on a device; **Product → Archive** to upload to TestFlight / App Store Connect.

## Without a Mac: Codemagic (or another macOS CI)

1. Connect the repo in Codemagic and pick a macOS instance.
2. Environment: the Supabase variables from `.env.local`, plus App Store Connect API key and signing certificates (Codemagic's automatic code signing).
3. Script steps:
   ```bash
   npm ci
   node scripts/build-mobile.mjs customer ios
   xcode-project use-profiles
   xcode-project build-ipa --project mobile/customer/ios/App/App.xcodeproj --scheme App
   ```
   (repeat for `driver`), then publish to TestFlight.

## Store notes

- The driver app's "Always" location request needs a clear justification for App Review (the `NSLocationAlwaysAndWhenInUseUsageDescription` text) and a demo account.
- Camera and photo access are used for ID cards (customer) and proof of delivery and documents (driver).
