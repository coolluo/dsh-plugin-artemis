@echo off
REM Double-clickable wrapper so the release works without PowerShell 7 (pwsh).
REM Windows PowerShell 5.1 ships with Windows; this bypasses the script
REM execution policy for this one file only.
REM
REM   publish.cmd               full release (login if needed, then publish)
REM   publish.cmd -CheckOnly    tests + package listing only
REM   set NO_PAUSE=1            do not wait for a key press at the end
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" %*
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" echo publish.cmd failed with exit code %EXITCODE%
if not defined NO_PAUSE pause
exit /b %EXITCODE%
