@echo off
title Quality Monitoring - Server
setlocal
set "ROOT=%~dp0"

rem Production run on the plant server (10.192.193.14). Unlike start.bat (development),
rem this builds both web apps once and runs a single backend process that serves:
rem   port 4000  API + worker web app (/app)  - Android APK, phone browsers
rem   port 5000  admin panel                  - desktop browsers
rem   port 4443  HTTPS worker web app         - iPhones (only when HTTPS_* is set in backend\.env)

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js was not found. Install Node.js 22 or newer from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist "%ROOT%backend\.env" (
  echo  backend\.env is missing. Copy backend\.env.example to backend\.env and fill it in.
  pause
  exit /b 1
)

echo.
echo  [1/4] Installing dependencies (first run only)
for %%D in (backend admin-web worker-mobile) do (
  if not exist "%ROOT%%%D\node_modules" (
    pushd "%ROOT%%%D" & call npm install & popd
  )
)

if /i "%~1"=="--no-build" goto run

echo  [2/4] Building the admin panel (admin-web\dist)
pushd "%ROOT%admin-web"
call npm run build
if errorlevel 1 ( popd & echo  Admin panel build failed. & pause & exit /b 1 )
popd

echo  [3/4] Building the worker web app (worker-mobile\dist)
pushd "%ROOT%worker-mobile"
call npm run build:web
if errorlevel 1 ( popd & echo  Worker web app build failed. & pause & exit /b 1 )
popd

:run
echo  [4/4] Starting the backend
echo.
echo    Desktop (admin panel):     http://10.192.193.14:5000
echo    Android APK server:        http://10.192.193.14:4000
echo    Phone browser (worker):    http://10.192.193.14:4000/app/
echo.
pushd "%ROOT%backend"
rem Database migrations run automatically at startup (src/index.ts).
call npm start
popd
pause
endlocal
