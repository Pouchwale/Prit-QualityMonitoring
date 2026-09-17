# Push notifications: build the APK and turn them on

The code is finished. What is left needs your accounts, so run these steps yourself. They take about 30–45 minutes, most of it waiting for the build.

You need: a free **Expo** account (builds the APK) and a free **Firebase** project (Google's Android push service). Android phones can only receive push through Firebase, whichever tool builds the app.

---

## Step 1 — Expo account and project id

```bash
cd "D:\QUality project\worker-mobile"
npx eas-cli@latest login      # create the account first at https://expo.dev/signup
npx eas-cli@latest init       # answer Y; this writes the project id into app.json
```

`eas init` adds `extra.eas.projectId` to `app.json`. The phone cannot get a push token without it.

## Step 2 — Firebase project and the push key

1. Go to https://console.firebase.google.com and **Add project** (name it e.g. `pouchwale-quality`). Google Analytics is not needed.
2. In the project, open **⚙ Project settings → General → Your apps → Add app → Android**.
   - Android package name: **`com.pouchwale.qualityworker`** (must match exactly)
   - Register the app. You can skip downloading `google-services.json`; EAS generates it.
3. Open **⚙ Project settings → Service accounts → Firebase Admin SDK → Generate new private key**. A `.json` file downloads. Keep it private, it is a password.
4. Upload that key to Expo:

```bash
npx eas-cli@latest credentials
```

Choose **Android** → **production** (or the profile you build) → **Google Service Account** → **Manage your Google Service Account Key for Push Notifications (FCM V1)** → **Set up a Google Service Account Key** → pick the `.json` file you downloaded.

## Step 3 — Point the app at your backend

The APK is a normal installed app, so it cannot discover the PC the way Expo Go does. It uses the address in `eas.json`.

I set it to **`http://10.80.88.185:4000`** (this PC's Wi-Fi address today). Check it still matches:

```bash
ipconfig    # look at "IPv4 Address" for your Wi-Fi adapter
```

If it changed, edit the three `EXPO_PUBLIC_API_URL` values in `eas.json` and rebuild. A fixed IP for the backend PC (or a DHCP reservation on the router) saves you from rebuilding later.

Also allow port 4000 through the Windows firewall once:

```powershell
New-NetFirewallRule -DisplayName "Quality backend 4000" -Direction Inbound -LocalPort 4000 -Protocol TCP -Action Allow
```

## Step 4 — Build the APK

```bash
npx eas-cli@latest build --profile preview --platform android
```

The build runs on Expo's servers (10–20 minutes). At the end you get a download link and a QR code. Open that link **on the phone** and install the APK. Android will warn about installing outside the Play Store; allow it.

Rebuild whenever you change `eas.json`, `app.json` or install a native package. Ordinary JavaScript changes do **not** need a rebuild for a production APK, but they do need one to be included.

## Step 5 — Test it

1. Open the app on the phone and sign in as the worker. Allow notifications when asked.
2. Check **Profile → Alerts** says alerts are on, and **Profile → My machines** shows the assigned machine.
3. In the Admin panel, open **Machine Assignment** and press **Test alert** on that worker. The phone should show a notification within a few seconds. The Admin toast tells you how many phones are registered; "No phone registered" means the worker has not signed in to the APK yet or notifications are blocked on the phone.
4. Real test: **Quality Checks → Create Test Check** → status **Due now** for that worker's machine. Within a minute the phone gets "Quality check due — <machine>".
5. Close the app fully (swipe it away) and lock the phone, then create another test check. The notification still arrives; tapping it opens that check.

## How it works

```
Admin assigns Prit → AKO 320
        ↓
Backend creates the AKO 320 checks from the schedule
        ↓
A check becomes due (backend checks every minute)
        ↓
Backend → Expo push service → Firebase (FCM) → phone
        ↓
🔔 "Quality check due — AKO 320 · Routine Quality Check"
        ↓
Prit taps it → that check opens in the app
```

- Only the workers assigned to that machine are sent anything.
- Each check notifies once: the backend stamps `notified_at` before sending.
- Delivery is confirmed with Expo receipts; a phone that uninstalls the app is dropped automatically.

## If a notification does not arrive

| Symptom | Cause |
| --- | --- |
| Admin says "No phone registered" | Worker has not signed in to the APK, or notifications are blocked. Check Profile → Alerts. |
| Nothing arrives, no error | The Firebase key is missing or was uploaded to a different build profile. Re-run `npx eas-cli@latest credentials`. |
| App cannot reach the server at all | Wrong `EXPO_PUBLIC_API_URL` in `eas.json`, PC's IP changed, firewall, or phone on a different Wi-Fi. |
| Backend log shows "Push not delivered" | Expo's message explains it; `DeviceNotRegistered` means that phone removed the app. |

Backend log lines to watch for: `Notified N device(s) about M due check(s)`.
Set `PUSH_DISABLED=1` in `backend/.env` to stop sending; `npm run notify:once` in `backend/` runs one pass by hand.
