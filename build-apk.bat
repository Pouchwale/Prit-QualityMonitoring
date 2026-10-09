@echo off
title Quality Monitoring - Build Android APK
setlocal
set "ROOT=%~dp0"

rem Builds the Android APK on Expo's servers (EAS Build), "preview" profile in worker-mobile\eas.json:
rem the app connects to http://10.192.193.14:4000. It takes 10-20 minutes and ends with a download
rem link and QR code for the APK (also listed at https://expo.dev under the project's Builds).
rem
rem Git is not installed on this PC, so EAS runs without version control (EAS_NO_VCS=1): it uploads
rem the worker-mobile folder as it is, minus what worker-mobile\.easignore excludes (node_modules,
rem dist, .env files, keys). Without this, EAS stops with "git command not found".

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js was not found. Install Node.js 22 or newer from https://nodejs.org and try again.
  pause
  exit /b 1
)

set "EAS_NO_VCS=1"
set "EAS_PROJECT_ROOT=%ROOT%worker-mobile"
cd /d "%ROOT%worker-mobile"
if not exist node_modules call npm install

rem Asks to sign in to Expo first when this PC is not signed in (the project's account: prit1177).
call npx eas-cli@latest build --profile preview --platform android %*

echo.
pause
endlocal
