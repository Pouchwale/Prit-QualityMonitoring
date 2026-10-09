@echo off
rem Rebuilds "Quality Server.exe" in the project folder from QualityServer.cs, with the
rem C# compiler that comes with Windows (.NET Framework 4). No other tools needed.
setlocal
set "HERE=%~dp0"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"

"%CSC%" /nologo /target:winexe /optimize+ /win32icon:"%HERE%app.ico" ^
  /reference:System.Windows.Forms.dll ^
  /out:"%HERE%..\Quality Server.exe" "%HERE%QualityServer.cs"
if errorlevel 1 ( echo Build failed. & exit /b 1 )
echo Built "Quality Server.exe"
endlocal
