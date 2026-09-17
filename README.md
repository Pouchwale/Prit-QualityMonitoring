# Quality Monitoring App

Digital periodic quality checks for manufacturing: workers capture live evidence on the phone, admins configure everything and monitor results.

One system, one backend and one PostgreSQL database, used from:

| Who | Device | How |
| --- | --- | --- |
| Worker | Android phone | Android app (APK) |
| Worker | iPhone, Android browser, PC | Worker web app / PWA at `http(s)://<server>/app/`, the same code as the Android app |
| Admin, Manager | PC, tablet or phone | Admin panel (responsive) |

| Folder | What it is | Stack |
| --- | --- | --- |
| `backend/` | REST API, database, photo/video storage, notifications, serves the worker web app | Node.js, Express, TypeScript, Drizzle ORM, PostgreSQL |
| `admin-web/` | Admin panel for admins and managers | React, Vite, TypeScript, Tailwind CSS |
| `worker-mobile/` | Worker app: Android app and, exported for the web, the worker web app | Expo, React Native, React Native Web, TypeScript, NativeWind (Tailwind) |

All configuration (machines, workers, departments, shifts, schedules, parameters, check types, photo/video rules, machine assignment) lives in PostgreSQL. The worker app reads the latest configuration from the backend every time a check is opened.

**Machine assignment decides everything a worker sees.** In **Admin → Machine Assignment** you choose which machines each worker is responsible for. A worker only sees, submits and is alerted about checks for those machines, even if a schedule names them. Change the assignment and the next checks and alerts follow the new machine immediately.

## 1. Backend

Requirements: Node.js 22+, PostgreSQL (tested with 18).

```bash
cd backend
npm install
cp .env.example .env        # then set DATABASE_URL with your PostgreSQL user and password
npm run db:setup            # creates the database, applies migrations, loads starter data
npm run dev                 # http://localhost:4000
```

Starter accounts created by `db:setup` (passwords come from `.env`, change them after first login):

| App | Employee ID | Password | Role |
| --- | --- | --- | --- |
| Admin panel | `ADMIN` | `admin123` | Super Admin |
| Worker app (Android or web) | `EMP-104` | `worker123` | Worker |

Starter data includes the seven PRD parameters (Viscosity, Repeat Length, Corona Treatment, TEAP Test, Deep Punching, Registration, Print Prachar), one check type using them, and demo hourly schedules on all three shifts for `EMP-104`. Acceptance limits are empty except the PRD example for Viscosity — enter the company-approved SOP limits in **Admin → Parameters**.

Photos and videos are saved under `backend/uploads/quality-checks/YYYY-MM-DD/` and `backend/uploads/exceptions/YYYY-MM-DD/`; the database stores the path. Storage sits behind `src/storage/StorageService.ts` so it can be replaced by MinIO/S3 later.

After changing `src/db/schema.ts`, run `npm run db:generate` and then `npm run db:migrate`.

## Roles and manager permissions

| Role | Can use |
| --- | --- |
| **Super Admin** | Everything, including Admin accounts |
| **Admin** | Every module; creates Managers and Workers and sets manager permissions |
| **Manager** | Only the modules an Admin gives them, each as **View** or **Manage** |
| **Worker** | The worker app (Android app or web app) |

**Admin → Manager Access** lists the managers. Pick one and set each module to *No access*, *View* or *Manage*, then save. You can also add, edit, activate and deactivate manager accounts there. A new manager has no access until you grant it. Dashboard, Reports and Audit Logs are view-only modules.

Permissions are stored in the database (`manager_permissions`) and **checked by the backend on every request**, so hiding a page in the panel is not the only protection. A change applies on the manager's next click, without signing out. Deactivating a manager signs them out at once.

Pages load lists from other modules for their dropdowns: a manager with *Schedules* needs machine and shift names without the *Machines* module. Those lists are readable; the module's own page and every change are not. Managers only ever see worker accounts in these lists.

Existing databases are upgraded automatically: the first Admin becomes the Super Admin, and managers created earlier keep what they had before (view on every module, manage on none).

Everyone can open **My Account** to see their own access and change their password.

**Passwords:** only the **Super Admin** can change or reset another user's password (Workers & Users or Manager Access → Edit → New password). Admins and Managers see no password field when editing someone else, and the backend refuses it. Everyone, the Super Admin included, changes their own password in My Account, which asks for the current one. Setting the first password when creating an account is still allowed for anyone who may create that account.

**Viewing passwords:** only the **Super Admin** can view other users' passwords, with **View password** (key icon) in Workers & Users or on Manager Access. They confirm with their own password each time, and every view, including refused attempts, is written to the audit log without the password itself.

How it works: sign-in still uses the one-way bcrypt hash. Next to it the password is stored encrypted (AES-256-GCM). The key is **not** in the database: it is created on first use in `backend/secrets/password-view.key` (or set `PASSWORD_VIEW_KEY` in `.env`). A copy of the database alone does not reveal passwords, but the database and the key together do, so keep the server and backups access-controlled.

- **Back up `backend/secrets/password-view.key` together with the database.** Without it the stored copies cannot be shown; signing in still works, and setting a new password makes it viewable again.
- Passwords set **before** this feature were only stored as a hash and cannot be recovered. They show "Not available" until the password is next set: a Super Admin reset, or the user changing it in My Account.

## 2. Admin panel

```bash
cd admin-web
npm install
npm run dev                 # http://localhost:5173
```

The panel calls the backend on port 4000 of the same host. Set `VITE_API_URL` to use a different address.

To use it from a phone on the factory network, open `http://<PC address>:5173` (start.bat already runs Vite with `--host`).

### Phones and tablets

The admin panel works from 375px phones up. Desktop (1024px and wider) keeps the compact layout; below that:

- The sidebar becomes a menu opened from the ☰ button in the header, which also shows the page title.
- Controls are touch-sized (40px inputs, 36px small buttons) and the root font is 16px instead of 13.5px. Components get this through `lg:` variants: write the touch size first and the desktop size with `lg:`, e.g. `h-[40px] lg:h-8`. Use pixel values for touch heights, because rem values are based on the 13.5px desktop root.
- Tables choose one of two phone layouts with a class on `<table>`:
  - `stack-sm`: list tables. Below 768px each row becomes a card, with the column name in front of every value. Labels are copied from the `<th>` cells automatically (`src/lib/responsiveTables.ts`), and cells showing only "—" are left out of the card.
  - `pin-first`: numeric comparison tables. They keep their columns and scroll sideways inside their card, with the first column pinned.
- The page itself never scrolls sideways; wide content scrolls inside its own container.

## 3. Worker app

```bash
cd worker-mobile
npm install
npx expo start
```

Open it with Expo Go on a phone connected to the same Wi-Fi as the PC. In development the app automatically uses the PC running Expo as the backend (`http://<pc-ip>:4000`). For a fixed server set `EXPO_PUBLIC_API_URL`, e.g. `EXPO_PUBLIC_API_URL=http://192.168.0.10:4000`. Allow port 4000 through the Windows firewall if the phone cannot connect.

Note: standalone Android builds block plain `http://` by default; use HTTPS or enable cleartext traffic (`expo-build-properties`) for production builds.

## Who does each check

Every quality check is stored with the worker responsible for it, and the admin panel, reports, worker app and alerts all use that worker (`backend/src/services/workerAssignment.ts`). The worker comes from **Machine Assignment** and each worker's shift:

1. the worker named on the schedule, if they are still assigned to the machine;
2. otherwise, the worker assigned to the machine who works that shift;
3. otherwise, a worker assigned to the machine who has no fixed shift.

When several workers qualify, checks are shared evenly between them. When nobody qualifies, the shift has no worker for that machine: **no checks are created for it**, and the Dashboard, Schedules and Machine Assignment pages show "Shift with no worker" until one is assigned. Open checks follow changes: if a machine is taken away from a worker, or a worker is disabled, their upcoming checks move to the right worker, or are removed when nobody is left. At startup, older checks stored without a worker are repaired: submitted checks take the worker who submitted them, missed checks take the responsible worker under the current assignment, and missed checks on shifts that have no worker are removed.

## Plant Calendar (closed days)

**Admin → Plant Calendar** marks days when the plant does not run, as **Plant Closed**, **Holiday** or **Shutdown**, with an optional reason. It has a month view with previous/next navigation. You can mark one date or a range of days, then edit, move or remove a closed day. On a closed date, taken as the local date of each check's scheduled time:

- no scheduled checks are generated, and checks already generated for that date but never submitted are removed;
- no due alerts are sent to workers (Android app or web app);
- nothing is marked **Missed**; closing a past date also removes that date's Missed checks from monitoring and reports;
- Completed and Exception records already submitted are kept;
- a test check cannot be created on the date.

Removing a closed day (or moving it to another date) reopens the old date, and its checks are generated again from the schedules. The Dashboard and the worker app show "Plant closed today". Access is the **Plant Calendar** module in Manager Access: view shows the calendar, and manage marks, edits and removes days. Every change is written to the audit log. The logic is in `backend/src/services/plantCalendar.ts`.

## Quality Monitoring Report (PDF)

**Admin → Reports → Download Report (PDF)** builds the full IPQC-style report for the selected date range and filters. It is generated on the server (`backend/src/services/reportData.ts` assembles the data, `reportPdf.ts` lays it out), so every section is built from the database and reconciles with the detailed log.

Sections: report header, executive summary, result breakdown, machine-wise, worker-wise, shift-wise and date-wise summaries, the full check log (one row per scheduled check, with its Check ID), completed check details with each parameter reading, parameter readings outside limits, missed checks, exception checks, quality issues requiring attention, performance analysis, trends, evidence appendix with the captured photos, and a sign-off block. Every page is **A4 portrait** with the same margins, header and footer — there are no landscape pages. Wide tables are fitted to the portrait width by stacking related fields in one column (machine over code, worker over employee ID, date over time). Table headers repeat on every page and rows are never split.

`gridWidths()` in `reportPdf.ts` checks each table against the portrait budget and warns in the backend log if a table would print past the margin. pdfmake treats column `widths` as *content* widths and adds cell padding and rules on top, so the budget is `523 − columns × 6.4 − 0.4` points.

**Status and Result** of a check are only **Completed**, **Missed** or **Exception** (`backend/src/lib/result.ts`). They track whether the worker did the scheduled check, not whether the readings were good:

- **Completed** — the worker submitted the required photo/video and form.
- **Missed** — not completed or submitted within the required time.
- **Exception** — the check could not be done; the worker submitted exception details and photo/video.

A check that is not finished yet has no status and shows "—" (counted as *Open*). Parameter readings keep their own PASS/FAIL against the limits as separate data; a reading outside its limits never changes the status. **Completion Rate** = Completed ÷ Scheduled.

Fields the system does not record (corrective action, CAPA reference, a reason for a missed check) print as "Not Available" or "Reason not provided" rather than being invented. An optional plant name (**Admin → Settings → Plant name**) prints under the company name; leave it empty and no plant line is shown, in the report or in the Admin header. The company name comes from the `company` setting (`{ "name": ..., "department": ... }`), falling back to Gujarat Print Pack Publications Pvt. Ltd. and Quality / IPQC.

## Worker web app (iPhone and PC)

iPhones cannot install the Android APK, so the same worker app is also built for the web. It is the same code as the Android app (Expo + React Native Web), uses the same APIs, login, machine assignment, checks and notifications, and is served by the backend:

```bash
cd worker-mobile
npm run build:web          # writes worker-mobile/dist; start.bat does this for you
```

Open `http://<server>:4000/app/` on the phone or PC (the backend root `/` redirects there). Workers sign in with their employee ID, select their machine, tap **Click Image** or **Exception**, take the photo, fill the form and submit, exactly as in the Android app.

Only a few device-specific pieces differ, in `*.web.tsx` / `*.web.ts` files next to the phone versions: the camera (browser camera), token storage (browser storage), dialogs, the date picker and notifications (Web Push).

### HTTPS: needed on iPhones for the live camera, Home Screen app and notifications

Browsers only allow these on HTTPS, with a certificate the device trusts:

| Over | Camera | Add to Home Screen | Notifications |
| --- | --- | --- | --- |
| Plain HTTP (`http://<server>:4000/app/`) | Opens the phone's camera for each photo | No | No |
| HTTPS with a trusted certificate (`https://<server>:4443/app/`) | Live camera preview inside the app | Yes | Yes (iPhone: from the Home Screen app, iOS 16.4+) |

The backend runs HTTPS **next to** HTTP: the Android app and the admin panel keep using port 4000, because Android apps do not trust a company certificate installed on the phone.

To turn HTTPS on with a company certificate authority (for example with [mkcert](https://github.com/FiloSottile/mkcert)) on the server PC:

```bash
mkcert -install
mkcert -cert-file backend/certs/server.pem -key-file backend/certs/server-key.pem 192.168.0.105 localhost
```

Use the server's LAN address (or its DNS name). Then set in `backend/.env`:

```
HTTPS_PORT=4443
HTTPS_CERT_FILE=certs/server.pem
HTTPS_KEY_FILE=certs/server-key.pem
```

Restart the backend; its log prints the `https://…/app/` address. Allow port 4443 through the Windows firewall. Each phone must trust the certificate authority once: copy `rootCA.pem` from `mkcert -CAROOT` to the phone, install it, and on iPhone also enable it under **Settings → General → About → Certificate Trust Settings**. A certificate from your company's domain avoids this step.

**iPhone workers, once:** open the `https://` address in Safari → **Share** → **Add to Home Screen**. Open **Quality Worker** from the Home Screen, sign in, go to **Profile** and tap **Turn on alerts**.

Photo rules are the same as in the Android app: photos are taken now, not picked from the gallery. Without HTTPS, where the page cannot show a live camera, the phone's camera opens instead and a file older than 10 minutes is refused. The backend still enforces its own 30-minute freshness check and rejects duplicate files.

## Phone alerts for due checks

The backend checks every minute for checks that have just become due and alerts the workers assigned to that machine. How the alert reaches the phone depends on how the app is running:

| Running as | How alerts arrive | Works when the app is closed |
| --- | --- | --- |
| **Expo Go** (development) | The app schedules the alerts on the phone itself from the check list it fetched | Yes, but only for checks it knew about the last time it was open |
| **Development or production build** | The backend sends them through Expo's push service | Yes, always |
| **Worker web app** (iPhone, Android browser, PC) | The backend sends them through Web Push; the browser's service worker shows them | Yes, needs HTTPS (see above). On iPhone only from the Home Screen app |

All three go to the same recipients (the workers assigned to the machine) and each check is notified once. **Admin → Machine Assignment → Test alert** reaches phones and browsers alike.

Expo Go cannot receive server-sent push notifications (Expo removed that in SDK 53), which is why the app falls back to scheduling them locally during development. **The real setup is an installed APK with server push** — see `worker-mobile/PUSH_SETUP.md` for the full steps (Expo account, Firebase key, `eas build`, install, test).

The worker turns alerts on by allowing the permission the first time they sign in; **Profile → Alerts** shows the current state. Set `PUSH_DISABLED=1` in `backend/.env` to stop the backend sending anything, and run `npm run notify:once` in `backend/` to trigger one pass by hand.
