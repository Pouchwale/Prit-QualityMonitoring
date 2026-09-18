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
| `worker-mobile/` | Mobile app for every role (Workers, Managers, Admins, Super Admin): Android app and, exported for the web, the web app | Expo, React Native, React Native Web, TypeScript, NativeWind (Tailwind) |

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
| Mobile app (Android or web) | `EMP-104` | `worker123` | Worker |

Starter data includes the seven PRD parameters (Viscosity, Repeat Length, Corona Treatment, TEAP Test, Deep Punching, Registration, Print Prachar), one check type using them, and demo hourly schedules on all three shifts for `EMP-104`. Acceptance limits are empty except the PRD example for Viscosity — enter the company-approved SOP limits in **Admin → Parameters**.

Photos and videos are saved under `backend/uploads/quality-checks/YYYY-MM-DD/` and `backend/uploads/exceptions/YYYY-MM-DD/`; the database stores the path. The files are **not public**: API responses that the caller is allowed to see (a check, an exception, a worker's own record) contain signed links, `/media/<path>?exp=…&sig=…`, valid for 12 hours (`src/lib/mediaLinks.ts`). A link without a valid signature, or an expired one, returns 403. Links in a CSV export also expire after 12 hours; export again for fresh ones. Set `MEDIA_LINK_SECRET` to use a dedicated signing secret (by default it is derived from `JWT_ACCESS_SECRET`, so changing that invalidates open links). Storage sits behind `src/storage/StorageService.ts` so it can be replaced by MinIO/S3 later.

After changing `src/db/schema.ts`, run `npm run db:generate` and then `npm run db:migrate`.

## Roles and manager permissions

| Role | Can use |
| --- | --- |
| **Super Admin** | Everything, including Admin accounts |
| **Admin** | Every module; creates Managers and Workers and sets manager permissions |
| **Manager** | Only the modules an Admin gives them, each as **View** or **Manage** |
| **Worker** | The mobile app's worker screens (Android app or web app) |

**Admin → Manager Access** lists the managers. Pick one and set each module to *No access*, *View* or *Manage*, then save. You can also add, edit, activate and deactivate manager accounts there. A new manager has no access until you grant it. Dashboard, Reports and Audit Logs are view-only modules.

Permissions are stored in the database (`manager_permissions`) and **checked by the backend on every request**, so hiding a page in the panel is not the only protection. A change applies on the manager's next click, without signing out. Deactivating a manager signs them out at once.

Pages load lists from other modules for their dropdowns: a manager with *Schedules* needs machine and shift names without the *Machines* module. Those lists are readable; the module's own page and every change are not. Managers only ever see worker accounts in these lists.

Existing databases are upgraded automatically: the first Admin becomes the Super Admin, and managers created earlier keep what they had before (view on every module, manage on none).

Everyone can open **My Account** to see their profile and access. Only the **Super Admin** sees a **Change my password** form there.

**Passwords:** password management is **Super Admin only**. The Super Admin changes their own password in My Account, and sets or resets other users' passwords in Workers & Users or Manager Access → Edit → New password. Admins, Managers and Workers have no change-password form. The backend refuses their requests with 403 (`POST /api/auth/change-password` and a password in `PUT /api/users/:id`), and refused attempts are written to the audit log. New accounts still get an initial password when they are created.

**Viewing passwords:** only the **Super Admin** can view other users' passwords, with **View password** (key icon) in Workers & Users or on Manager Access. They confirm with their own password each time, and every view, including refused attempts, is written to the audit log without the password itself.

How it works: sign-in still uses the one-way bcrypt hash. Next to it the password is stored encrypted (AES-256-GCM). The key is **not** in the database: it is created on first use in `backend/secrets/password-view.key` (or set `PASSWORD_VIEW_KEY` in `.env`). A copy of the database alone does not reveal passwords, but the database and the key together do, so keep the server and backups access-controlled.

- **Back up `backend/secrets/password-view.key` together with the database.** Without it the stored copies cannot be shown; signing in still works, and setting a new password makes it viewable again.
- Passwords set **before** this feature were only stored as a hash and cannot be recovered. They show "Not available" until the password is next set: a Super Admin reset, or the Super Admin changing their own password in My Account.

## One mobile app for every role

Workers, Managers, Admins and the Super Admin sign in to the **same mobile app** with their usual employee ID and password. The app reads the account's role and permissions from the backend (`GET /api/auth/me`) and opens:

- **Worker:** the worker screens as before (Today, History, Profile, checks, exceptions, alerts).
- **Admin / Super Admin:** a plant dashboard (progress, closed-day and shift-without-worker warnings, missed checks, repeated misses, recent submissions, setup issues) and every admin panel module: Quality Checks, Exceptions, Reports (CSV and PDF), Plant Calendar with annual calendars and weekly rules, Workers & Users, Machine Assignment, Manager Access, Machines, Check Types, Parameters, Schedules, Departments, Shifts, Audit Logs, Settings and My Account.
- **Manager:** a monitoring dashboard (today's progress, missed checks by worker, exceptions awaiting review, their own access) and only the modules granted in Manager Access, as View or Manage.

Tabs and actions follow the permissions: a module without access is not shown, and edit/add/delete buttons only appear with Manage. Permissions are re-read every minute and when the app returns to the foreground. **The backend still checks every request**, so hidden screens are not the protection: Workers get 403 on every staff API, staff accounts get 403 on the worker APIs, Managers get 403 outside their modules and on Admin/Super Admin features (Manager Access, Admin accounts, passwords).

**Mobile app access:** each account has a **Mobile app access** switch (Workers & Users → Edit, or Manager Access → Edit). When it is off, mobile sign-in is refused and an open mobile session is refused on its next request; the account's web panel session is not affected. The starter Super Admin starts with it off: turn it on in Workers & Users to use the app.

The screens live in `worker-mobile/src/staff/` (`StaffApp.tsx`, `screens/*`); the worker screens in `worker-mobile/src/worker/WorkerApp.tsx`. Login sends `app: 'mobile'`; older worker app versions (`app: 'worker'`) keep working for Workers.

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

## 3. Mobile app

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

## Monitoring setup: what each parameter needs

**Admin → Monitoring Setup** (web panel and mobile app) shows every machine, its check types and what the worker must do. Nothing in the worker app is hardcoded; it follows this configuration.

**Per parameter** (Check Types → parameter row): Required, **Photo**, **Video**, **Allow N/A**, and **Only while a job is running**. A parameter can need a photo, a video, both or neither, so a worker is never asked for evidence a reading does not need. For example: Viscosity photo only, Printing Quality photo and video, Machine Condition video only. The check type also keeps optional **Overall check photo/video** for one picture of the whole check, and **Allow manual submission**.

**Per machine and check type** (Schedules): the **monitoring interval**, the shift, the optional time window, the assigned worker and the **monitoring mode**:

- **Every interval** — the check is due every N minutes during the shift.
- **Job-based** — checks run only while a job is running on that machine.
- **Manual only** — no schedule; the worker submits when needed.

**Not Applicable reasons** are configurable (Monitoring Setup → N/A reasons; "Other" requires a remark). A parameter marked Not Applicable is recorded with its reason, never counted as Missed or Failed, and the check still counts as Completed.

Changing this configuration needs **Manage** on the module (Check Types, Schedules); Admins and the Super Admin always have it.

## Monitoring timer: the next check starts from the last submission

The interval is counted from **the actual submission**, not from the previous notification (`backend/src/services/checkGenerator.ts`, `services/monitoringTimer.ts`):

- Interval 1 hour, check due 10:00, notification sent.
- The worker submits at 10:50, before the shift or job ends.
- The next check is due at **11:50**, and the 11:00 slot is never created or notified.

Only one check per machine and check type is open at a time (a database rule, not just app logic), so a notification is never sent twice. A missed check keeps the cadence: the next one is due an interval after the missed one. Each submission stores its time and the next monitoring time (`schedule_timers`, and `next_due_at` on the check) for audit. Times are stored in UTC; shift start and end are resolved in the plant timezone (`PLANT_TIMEZONE`, default `Asia/Kolkata`), so the server can run in any timezone.

**Manual submission:** the worker opens the machine and taps **Start check** at any time, without waiting for a notification. Manual submissions follow exactly the same required fields, evidence rules and limits, are marked **Manual** in the check, reports and CSV, and reset the timer the same way.

**Jobs:** on a machine with job-based checks the worker taps **Start job** (Job No.) and **End job**. Job-based checks are due from the job start and then every interval; nothing is due, and nothing is Missed, when no job is running. Parameters set to "Only while a job is running" are skipped automatically with the reason "No job running" when there is no job. Admins can see jobs and close a forgotten one in **Monitoring Setup → Jobs**.

## Plant Calendar (closed days)

**Admin → Plant Calendar** marks days when the plant does not run, as **Plant Closed**, **Holiday** or **Shutdown**, with an optional reason. It has a month view with previous/next navigation. You can mark one date or a range of days, then edit, move or remove a closed day. On a closed date, taken as the local date of each check's scheduled time:

- no scheduled checks are generated, and checks already generated for that date but never submitted are removed;
- no due alerts are sent to workers (Android app or web app);
- nothing is marked **Missed**; closing a past date also removes that date's Missed checks from monitoring and reports;
- Completed and Exception records already submitted are kept;
- a test check cannot be created on the date.

**Weekly off.** The plant is normally closed on **Thursdays**. Every Thursday is treated as a closed day (no checks, no alerts, nothing Missed) unless that date has its own calendar entry. The weekly off days can be changed on the Plant Calendar page (Weekly off card). For each date the most specific setting wins:

1. a calendar entry for that date: **Adjustment Working Day** opens the plant, while Plant Closed, Holiday or Shutdown closes it;
2. otherwise the weekly off days are closed;
3. every other day is open.

So a Thursday marked as an Adjustment Working Day runs normally with checks and alerts, and all other Thursdays stay closed. Removing an Adjustment Working Day from a Thursday closes that date again and removes its open checks.

**Adjustment Working Day** is a fourth entry type. It marks a date the plant works although it would otherwise be closed, such as a Thursday worked in place of a holiday. The plant runs normally on those dates: checks are scheduled, workers get alerts and Missed checks count as usual.

**2026 company calendar.** The Gujarat Print Pack Publication 2026 calendar sheet is loaded into the Plant Calendar the first time the backend starts (`backend/src/db/holidayCalendar2026.ts`). It has 13 holidays: Uttarayan, Republic Day, Dhuleti, Independence Day, Rakshabandhan, Janmashtami, Navratri Ashtami, Navratri Nom, Bestu Varas, Bhai Dooj, and Padatar Divas on 11–13 Nov. It also has 8 adjustment working days, all Thursdays, each labelled with the holiday it replaces: 29/01, 06/08, 20/08, 01/10, 08/10, 22/10, 29/10 and 05/11. The import runs once per database, so later edits in the admin panel are kept, and any date that already had an entry is left unchanged. Missed checks already recorded on past holidays are removed. Databases that loaded an earlier, mistyped list of adjustment dates are corrected once; entries an admin created are left alone.

Removing a closed day (or moving it to another date) reopens the old date, and its checks are generated again from the schedules. The Dashboard and the worker app show "Plant closed today". Access is the **Plant Calendar** module in Manager Access: view shows the calendar, and manage marks, edits and removes days. Every change is written to the audit log. The logic is in `backend/src/services/plantCalendar.ts`.

## Annual calendars (2027 onwards)

From **1 Jan 2027**, plant closures come from the database, so there is no yearly code or data entry. Dates up to **31 Dec 2026** keep the original Plant Calendar setup exactly as it is: the 2026 holidays and adjustment days, and the Thursday weekly off, which is now locked. As a result, 2026 check statuses, Missed counts and reports never change.

**Admin → Plant Calendar** has three tabs:

- **Calendar**: the month view. Every day shows whether the plant is open and why (holiday, adjustment working day, weekly off). A date from 2027 links to its annual calendar.
- **Annual calendars**: one calendar per year (2027, 2028, …).
  1. Create the year.
  2. **Import the company document.** Excel (.xlsx) and CSV are read exactly, and so is a PDF that contains text. Photos and scanned PDFs are read with **offline OCR** (Tesseract with English and Gujarati, running on this server, so the document never leaves it).
  3. **Review.** The document is shown next to the extracted dates. The admin can edit, add, delete or confirm every row.
  4. **Approve.** Only approved dates affect scheduling. Edits made after approval wait for the next approval, and the published dates stay in use until then.
- **Weekly rules**: recurring closures, e.g. *every Thursday from 2027-01-01, no end date*. Rules apply to every future year automatically. A rule can be added, ended or (before it starts) deleted, but a change can only take effect from today onwards, never earlier.

**Nothing is guessed.** OCR readings below 85% confidence, or dates that do not agree with a second digits-only reading, are marked *uncertain*. An unreadable date is left empty. Approval is blocked until every row is fixed or confirmed against the document. The review also detects conflicts:

- **Must be fixed:** a date listed twice, a date outside the year, a row with no date, and any change to a date that has already passed.
- **Must be confirmed:** the weekday printed on the document not matching the date; an adjustment working day that falls on a day that is already open, i.e. not a weekly off; an adjustment day without its holiday; and uncertain OCR readings.

**Priority for a date:** an approved Adjustment Working Day opens the plant; an approved Holiday, Plant Closed or Shutdown closes it; otherwise the weekly rules apply; otherwise the plant is open. Closed dates generate no checks and no alerts, and nothing on them is marked Missed. Adjustment working days run normally.

The code is in `backend/src/services/weeklyRules.ts`, `calendarYears.ts` (review, conflicts, approval), `calendarExtraction.ts` (Excel/PDF/OCR) and `calendarImport.ts` (rows → dates). Uploaded documents are stored in `backend/calendar-documents/` (not committed) and are only served to signed-in users with Plant Calendar access.

## Quality Monitoring Report (PDF)

**Admin → Reports → Download Report (PDF)** builds the full IPQC-style report for the selected date range and filters. It is generated on the server (`backend/src/services/reportData.ts` assembles the data, `reportPdf.ts` lays it out), so every section is built from the database and reconciles with the detailed log.

Sections: report header, executive summary, result breakdown, machine-wise, worker-wise, shift-wise and date-wise summaries, the full check log (one row per scheduled check, with its Check ID), completed check details with each parameter reading, parameter readings outside limits, missed checks, exception checks, quality issues requiring attention, performance analysis, trends, evidence appendix with the captured photos, and a sign-off block. Every page is **A4 portrait** with the same margins, header and footer — there are no landscape pages. Wide tables are fitted to the portrait width by stacking related fields in one column (machine over code, worker over employee ID, date over time). Table headers repeat on every page and rows are never split.

`gridWidths()` in `reportPdf.ts` checks each table against the portrait budget and warns in the backend log if a table would print past the margin. pdfmake treats column `widths` as *content* widths and adds cell padding and rules on top, so the budget is `523 − columns × 6.4 − 0.4` points.

**Status and Result** of a check are only **Completed**, **Missed** or **Exception** (`backend/src/lib/result.ts`). They track whether the worker did the scheduled check, not whether the readings were good:

- **Completed** — the worker submitted the form with the evidence each parameter needs. Parameters marked **Not Applicable** (with their reason) are included; they are never counted as Missed or Failed.
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

Open `http://<server>:4000/app/` on the phone or PC (the backend root `/` redirects there). Workers sign in with their employee ID, select their machine, then **Start check** (or open a check they were alerted about), capture the photo or video each parameter needs, fill the form and submit, exactly as in the Android app. A confirmation screen shows what was sent and when the next check is due.

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
