@echo off
REM Fake npm used to exercise publish.ps1 without touching the real registry.
REM
REM   FAKE_FAIL=otp       -> publish fails with a real npm 403 2FA message
REM   FAKE_FAIL=eotp      -> publish fails with EOTP (one-time password prompt)
REM   FAKE_FAIL=e403      -> publish fails with a plain permission error
REM   FAKE_FAIL=auth      -> whoami fails, login succeeds, publish works
REM   (unset)             -> publish succeeds
REM
REM Flat control flow with goto: "exit /b" inside nested parentheses does not
REM reliably propagate the exit code through cmd /c.
setlocal

if "%~1"=="whoami" goto whoami
if "%~1"=="login" goto login
if "%~1"=="publish" goto publish
if "%~1"=="pack" goto pack
echo fake npm %*
exit /b 0

:whoami
if not "%FAKE_FAIL%"=="auth" (
  echo tester
  exit /b 0
)
if exist "%~dp0logged_in.flag" (
  echo tester
  exit /b 0
)
echo npm error code ENEEDAUTH 1>&2
exit /b 1

:login
echo fake login ok
type nul > "%~dp0logged_in.flag"
exit /b 0

:publish
if "%FAKE_FAIL%"=="otp" goto publish_otp
if "%FAKE_FAIL%"=="eotp" goto publish_eotp
if "%FAKE_FAIL%"=="e403" goto publish_e403
echo fake published dsh-plugin-artemis@0.1.0
exit /b 0

:publish_otp
echo npm error code E403 1>&2
echo npm error 403 403 Forbidden - PUT https://registry.npmjs.org/dsh-plugin-artemis - Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages. 1>&2
exit /b 1

:publish_eotp
echo npm error code EOTP 1>&2
echo npm error This operation requires a one-time password from your authenticator. 1>&2
exit /b 1

:publish_e403
echo npm error code E403 1>&2
echo npm error You do not have permission to publish dsh-plugin-artemis. 1>&2
exit /b 1

:pack
echo fake pack ok
exit /b 0
