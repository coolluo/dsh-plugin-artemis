# Probe: the not-logged-in path must return $null, not throw, under
# $ErrorActionPreference = 'Stop' (Windows PowerShell 5.1 included).

$ErrorActionPreference = "Stop"

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

try {
	$user = Get-NpmUser
	if ($null -eq $user) {
		Write-Host "PROBE OK: treated as not logged in, no exception"
	} else {
		Write-Host "PROBE OK: logged in as $user"
	}
} catch {
	Write-Host "PROBE FAILED: $($_.Exception.Message)"
	exit 1
}
