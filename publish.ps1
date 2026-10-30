# One-click release: run the tests, pack, and publish dsh-plugin-artemis.
#
# Works on Windows PowerShell 5.1 (powershell.exe) and PowerShell 7+ (pwsh).
#
#   publish.cmd                        double-click or run from any shell
#   publish.cmd -CheckOnly             tests + package listing only, no publish
#   publish.cmd -Otp 123456            publish with a one-time password
#   powershell -ExecutionPolicy Bypass -File publish.ps1 -CheckOnly
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads a BOM-less script
# as ANSI, so any UTF-8 multi-byte character can corrupt parsing on the machine.
#
# It uses npm.cmd because npm.ps1 is blocked by the Windows execution policy on
# this machine. `npm publish` packs the files listed in package.json `files`, so
# the tarball produced here is exactly what the registry receives.

param(
	[switch]$CheckOnly,
	[string]$Otp = ""
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$publishLog = Join-Path $PSScriptRoot "publish.log"

# npm writes "ENEEDAUTH" to stderr when nobody is logged in. With
# $ErrorActionPreference = "Stop" that stderr line becomes a terminating error in
# Windows PowerShell, so the probe must suppress stderr and read only the exit code.
function Get-NpmUser {
	$previous = $ErrorActionPreference
	$ErrorActionPreference = "Continue"
	try {
		$output = & npm.cmd whoami 2>$null
		if ($LASTEXITCODE -ne 0) { return $null }
		$user = ($output | Out-String).Trim()
		if ($user -eq "") { return $null }
		return $user
	} finally {
		$ErrorActionPreference = $previous
	}
}

Write-Host "== 1/4 unit tests ==" -ForegroundColor Cyan
node tests/unit.test.js
if ($LASTEXITCODE -ne 0) { throw "unit tests failed; not publishing" }

Write-Host "== 2/4 integration tests (spawns a mock MCP server) ==" -ForegroundColor Cyan
node tests/integration.test.js
if ($LASTEXITCODE -ne 0) { throw "integration tests failed; not publishing" }

Write-Host "== 3/4 package contents ==" -ForegroundColor Cyan
& npm.cmd pack --dry-run
if ($LASTEXITCODE -ne 0) { throw "npm pack failed" }

if ($CheckOnly) {
	Write-Host ""
	Write-Host "check-only: tests and packaging are fine; publish skipped." -ForegroundColor Green
	return
}

Write-Host "== 4/4 publish ==" -ForegroundColor Cyan
$user = Get-NpmUser
if ($null -eq $user) {
	Write-Host "Not logged in to npm (ENEEDAUTH)." -ForegroundColor Yellow
	Write-Host "  - no account yet: https://www.npmjs.com/signup (free)"
	Write-Host "  - npm requires 2FA for publishing: enable an authenticator app on your npm account first"
	Write-Host "Starting npm login..."
	& npm.cmd login
	if ($LASTEXITCODE -ne 0) { throw "npm login failed" }
	$user = Get-NpmUser
	if ($null -eq $user) { throw "login finished but 'npm whoami' still fails; run 'npm whoami' manually to inspect .npmrc" }
}

Write-Host "Publishing as: $user"

# Run npm publish while capturing its full output: the real reason is often a
# line or two above the summary, and the terminal scrollback loses it.
function Invoke-NpmPublish {
	param([string]$Code)
	$npmArgs = @("publish")
	if ($Code -ne "") { $npmArgs += "--otp=$Code" }
	$previous = $ErrorActionPreference
	$ErrorActionPreference = "Continue"
	try {
		$captured = & npm.cmd @npmArgs 2>&1 | ForEach-Object { "$_" }
		$exit = $LASTEXITCODE
	} finally {
		$ErrorActionPreference = $previous
	}
	return [pscustomobject]@{ Output = ($captured -join [Environment]::NewLine); Code = $exit }
}

$result = Invoke-NpmPublish $Otp
Write-Host $result.Output

# If npm asks for a code and nobody passed one, ask for it here and retry.
$attempts = 0
$canPrompt = -not [Console]::IsInputRedirected
while (
	$result.Code -ne 0 -and
	$Otp -eq "" -and
	$attempts -lt 2 -and
	$canPrompt -and
	$result.Output -match "two-factor|2fa|EOTP|one-time password"
) {
	$attempts++
	$code = Read-Host "Enter the 6-digit code from your authenticator (blank to abort)"
	if ([string]::IsNullOrWhiteSpace($code)) { break }
	Write-Host "Retrying with the code you entered..." -ForegroundColor Cyan
	$result = Invoke-NpmPublish $code.Trim()
	Write-Host $result.Output
}

$publishCode = $result.Code
$publishText = $result.Output
Set-Content -Path $publishLog -Value $publishText -Encoding UTF8

if ($publishCode -ne 0) {
	Write-Host ""
	Write-Host "npm publish failed (exit $publishCode). Full output saved to $publishLog" -ForegroundColor Red
	if ($publishText -match "two-factor|2fa|EOTP|one-time password") {
		Write-Host "Cause: npm requires 2FA to publish (this is a policy check, not a name conflict)." -ForegroundColor Yellow
		Write-Host "  Option A - pass a fresh 6-digit code:  publish.cmd -Otp 123456"
		Write-Host "  Option B - use a granular access token with 'Bypass 2FA':"
		Write-Host "     1) npmjs.com -> Access Tokens -> Generate New Token -> Granular Access Token"
		Write-Host "     2) Permissions: Read and write; enable 'Bypass 2FA'"
		Write-Host "     3) put it in %USERPROFILE%\.npmrc as:"
		Write-Host "        //registry.npmjs.org/:_authToken=YOUR_TOKEN"
		Write-Host "        (keep this file private; it grants publish rights)"
		Write-Host "  Then re-run publish.cmd."
	} elseif ($publishText -match "E403|403") {
		Write-Host "Cause: permission denied. The package name may already be taken, or this account does not own it." -ForegroundColor Yellow
		Write-Host "  Check: npm view dsh-plugin-artemis   (404 = free; anything else = taken)"
		Write-Host "  If taken, rename it in package.json (e.g. add a scope) and re-run."
	} elseif ($publishText -match "ENEEDAUTH|need auth") {
		Write-Host "Cause: still not authenticated. Run: npm login" -ForegroundColor Yellow
	} elseif ($publishText -match "EPUBLISHCONFLICT|cannot publish over") {
		Write-Host "Cause: this version already exists. Bump 'version' in package.json and re-run." -ForegroundColor Yellow
	} elseif ($publishText -match "EAI_AGAIN|ETIMEDOUT|ECONNRESET|network") {
		Write-Host "Cause: network problem reaching registry.npmjs.org. Check proxy/VPN and re-run." -ForegroundColor Yellow
	} else {
		Write-Host "Unrecognised error. The full npm output above and in $publishLog has the details." -ForegroundColor Yellow
	}
	Write-Host ""
	Write-Host "Nothing was published. Fix the cause above, then re-run publish.cmd." -ForegroundColor Red
	exit 1
}

Write-Host ""
Write-Host "Published. Users can now install it with:" -ForegroundColor Green
Write-Host "  dsh plugin --profile desktop add dsh-plugin-artemis"
