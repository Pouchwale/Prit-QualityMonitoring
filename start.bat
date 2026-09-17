@echo off
title Quality Monitoring - Launcher
setlocal
set "ROOT=%~dp0"

echo.
echo  Quality Monitoring - starting all apps
echo  --------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js was not found. Install Node.js 22 or newer from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

rem The backend needs backend\.env with the PostgreSQL connection (DATABASE_URL).
if not exist "%ROOT%backend\.env" (
  copy "%ROOT%backend\.env.example" "%ROOT%backend\.env" >nul
  echo  backend\.env was missing, so it was created from .env.example.
  echo  Set DATABASE_URL to your PostgreSQL user and password, save the file,
  echo  then double-click start.bat again.
  echo.
  start "" notepad "%ROOT%backend\.env"
  pause
  exit /b 1
)

rem Each app runs in its own window. Dependencies are installed on first run.
rem db:setup is safe to repeat: it creates the database if needed, applies new
rem migrations and only loads starter data into an empty database.

echo  Starting Backend        http://localhost:4000
start "Quality - Backend" /D "%ROOT%backend" cmd /k "(if not exist node_modules npm install) & npm run db:setup && npm run dev"

echo  Starting Admin Web      http://localhost:5173
start "Quality - Admin Web" /D "%ROOT%admin-web" cmd /k "(if not exist node_modules npm install) & npm run dev -- --host"

rem The same worker app is also built for the web (iPhone / PC) and served by the backend at /app.
echo  Starting Worker Mobile  (builds the web app for iPhone/PC, then Expo for Android)
echo                          Web app: http://localhost:4000/app/
start "Quality - Worker Mobile" /D "%ROOT%worker-mobile" cmd /k "(if not exist node_modules npm install) & npm run build:web & npx expo start"

rem Give the servers a moment, then open the admin panel in the browser.
timeout /t 8 /nobreak >nul
start "" http://localhost:5173

echo.
echo  All apps started. Close their windows to stop them.
echo.
timeout /t 5 >nul
endlocal
