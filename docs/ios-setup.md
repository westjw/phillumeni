# Getting phillumeni onto iOS (Capacitor → TestFlight → App Store)

The app is wrapped with **Capacitor** — the same web codebase, in a native iOS shell.
Capacitor is already installed and configured (`capacitor.config.json`, app id
**com.phillumeni.app**). What's left needs your Mac, Xcode, and your Apple Developer
account. Do the steps in order.

---

## 1. Install the toolchain (one-time, do this first — Xcode is a big download)

1. **Xcode** — install from the **Mac App Store**:
   https://apps.apple.com/us/app/xcode/id497799835 (~7 GB; Capacitor 8 needs Xcode 26+).
   Open it once after installing so it finishes setting up components, and accept the
   license when prompted.
2. Point the command-line tools at Xcode (not the standalone CLT):
   ```
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   ```
   *(No CocoaPods needed — Capacitor 8 uses Swift Package Manager, built into Xcode.)*

Verify:
```
xcodebuild -version
```

---

## 2. Generate the iOS project (one-time)

From the repo root (`~/Downloads/phillumeni`):
```
npm run build          # build the web assets into dist/
npx cap add ios        # creates the ios/ Xcode project (SPM-based)
npx cap sync ios       # copies the web build + plugins into the native project
```
This creates an `ios/` folder — commit it (Capacitor manages its own .gitignore inside).

---

## 3. Add the required permission strings (or the app crashes when used)

The app takes matchbook photos and can center the map on you, so iOS **requires** usage
descriptions. Open `ios/App/App/Info.plist` and add these keys (Xcode: right-click
Info.plist → Open As → Source Code, paste inside the top-level `<dict>`):

```xml
<key>NSCameraUsageDescription</key>
<string>phillumeni uses your camera to take photos of matchbooks you've found.</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>phillumeni lets you choose matchbook photos from your library.</string>
<key>NSPhotoLibraryAddUsageDescription</key>
<string>phillumeni can save matchbook photos you take.</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>phillumeni can center the map on your location. Your location is used on your device only and is never stored.</string>
```

---

## 4. Sign it (needs your Apple Developer account)

```
npx cap open ios       # opens the project in Xcode
```
In Xcode: select the **App** target → **Signing & Capabilities**:
- **Team:** your Apple Developer account (log in with your Apple ID if prompted).
- **Bundle Identifier:** `com.phillumeni.app` (should already be set).
- Leave "Automatically manage signing" checked.

---

## 5. Run it on a device / simulator

Pick a simulator (or your connected iPhone) at the top of Xcode and press **▶ Run**.
This is the moment of truth — you're looking at phillumeni as a real native app.

Sanity-check on device: sign up, take a matchbook photo (camera prompt should appear),
add a spot, open the map, tap the locate button (location prompt should appear).

---

## 6. Ship to TestFlight (your friends-beta, as a native app)

1. In **App Store Connect** (appstoreconnect.apple.com) → **Apps → +** → create the app:
   name **phillumeni**, bundle id **com.phillumeni.app**, a unique SKU (e.g. `phillumeni-ios`).
2. In Xcode: select **Any iOS Device (arm64)** as the target → **Product → Archive**.
3. When the Organizer opens → **Distribute App → App Store Connect → Upload**.
4. The build appears in App Store Connect → **TestFlight** after processing (~10–30 min).
5. Add your friends as testers (internal testers by Apple ID, or an external tester
   group with a public link). They install the **TestFlight** app and tap your invite.

---

## Everyday loop (after any web code change)

```
npm run build && npx cap sync ios
```
then re-run / re-archive in Xcode. (Web-only changes still deploy to the PWA on `git push`
as before — the native app only updates when you rebuild it.)

---

## Still to come (separate pieces, not needed for the first TestFlight build)

- **Push notifications** — new followers / friend activity / invite conversions. Needs an
  APNs key from your Apple account, the `@capacitor/push-notifications` plugin, and a
  send path (Supabase Edge Function). Build this before the full App Store submission.
- **App icon** — generate the icon set from a source image via `@capacitor/assets`.
- **App Store review submission** — screenshots, description, age rating, and the App
  Privacy labels (declare Email, Photos, Name, and **Location (Precise)** — all "App
  Functionality," none for tracking). Privacy policy URL: `https://phillumeni.vercel.app/privacy.html`.
