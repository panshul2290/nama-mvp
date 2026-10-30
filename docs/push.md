# Push notifications in the customer and driver apps

The apps use [`@capacitor/push-notifications`](https://capacitorjs.com/docs/apis/push-notifications) **8.1.3** (Capacitor 8). Code: `lib/push.ts`, `lib/pushRoute.ts`, `lib/usePush.ts`; build switches in `scripts/build-mobile.mjs`.

In-app notifications (the `notifications` table, live through Realtime, the bell and inbox) work with or without push. Push is an extra channel.

## What happens without Firebase (today)

There is no `google-services.json` in the repo, so:

- the Android build still works: `app/build.gradle` applies the Google Services plugin only when `android/app/google-services.json` exists, and `build-mobile.mjs` copies it there only when you provide it;
- the static export gets `NEXT_PUBLIC_PUSH_ANDROID=false`, so the app never calls `PushNotifications.register()` (on Android that call crashes the app when Firebase isn't initialised). It logs `[push] not configured for android in this build` once in the WebView console;
- the driver app still asks for the notification permission (Android 13+) when going online, because the "Sharing location — on shift" foreground-service notification needs it.

## Enable push on Android (Firebase Cloud Messaging)

1. In the [Firebase console](https://console.firebase.google.com/), create a project (or use NWS's), then **Add app → Android** twice:
   - customer app package: `om.nama.tanker.customer`
   - driver app package: `om.nama.tanker.driver`
2. Download each app's `google-services.json` and put it here (these paths are gitignored; the repo is public):
   - `mobile/customer/google-services.json`
   - `mobile/driver/google-services.json`
3. Build as usual: `npm run build:apk:customer` / `npm run build:apk:driver`. The script copies the file into `mobile/<app>/android/app/` and builds with `NEXT_PUBLIC_PUSH_ANDROID=true`.
4. Install, sign in, and place an order (customer) or go online (driver): the app asks for permission, registers, and calls `register_push_token(token, platform)`. If that RPC isn't in the database yet, the token isn't stored and the app logs it once.

## Enable push on iOS (APNs)

Needs an Apple Developer account (see `docs/ios.md`).

1. In Xcode, **Signing & Capabilities → + Capability → Push Notifications** (and keep **Background Modes → Remote notifications**, which the build script already sets in `Info.plist`).
2. Create an APNs key (**Certificates, IDs & Profiles → Keys**) for whichever service sends the pushes. If sending through Firebase, upload the key to the Firebase project and add iOS apps with bundle ids `om.nama.tanker.customer` / `om.nama.tanker.driver`; put each `GoogleService-Info.plist` at `mobile/<app>/GoogleService-Info.plist` (gitignored; the build script copies it into `ios/App/App/`, and you add it to the target once in Xcode).
3. Build with `NAMA_IOS_PUSH=1 node --env-file-if-exists=.env.local scripts/build-mobile.mjs <app> ios`. `AppDelegate.swift` already forwards the APNs token to the plugin (patched by the script).

Note: with plain APNs the token the plugin returns is an APNs token, not an FCM token; the sender has to match (FCM needs the Firebase iOS SDK set up to swap it for an FCM token).

## Sending (server side, not built yet)

Nothing sends pushes today. A sender (an Edge Function or a database webhook on `notifications` inserts) should read the user's tokens from `push_tokens` and send through FCM HTTP v1 / APNs, with a `data` payload the apps understand (`lib/pushRoute.ts`):

| `data` field | Meaning |
|---|---|
| `order_id` | open this order (customer) / the trip (driver) |
| `event` | the notification event, e.g. `new_message` (customer: opens the order's chat), `new_job` (driver: opens Jobs) |
| `route` | an explicit screen, used only when it starts with the app's own prefix (`/customer…` or `/driver…`) |

On Android, send to the `orders` notification channel (created by the app).
