# Quality Worker App

Expo + React Native + TypeScript, styled with NativeWind (Tailwind CSS).

## What workers do

1. **Sign in** with the employee ID and password set by the admin.
2. **Today** shows checks to do now, later today, and earlier today. The list refreshes every minute and when the app is opened.
3. **Open a check**: enter the Job No., tap **Click Image** (live camera, *Capture Photo*, preview, retake) and **Record Video** (live camera, *Record Video*, stop, preview, record again), fill the parameters, **Submit**.
4. **Exception** (top right of a check): choose a reason, add a remark, take a photo, submit.
5. **History** shows the last 7 days. **Profile** shows name, employee ID, department and role, with **Log Out**.

The form (parameters, order, required fields, photo/video/Job No. requirements) is loaded from the backend every time a check is opened, so admin changes apply immediately. There is no gallery or file picker: evidence can only be captured with the camera.

The worker only ever sees the machines the admin assigned to them (**Profile → My machines**), and only gets alerts for those machines. In Expo Go the alerts are scheduled on the phone; in a development or production build the backend sends them. See the root README for the difference.

## Run

```bash
npm install
npx expo start
```

The backend must be running (see the root README). The app uses `EXPO_PUBLIC_API_URL` if set, otherwise port 4000 on the PC running Expo.
