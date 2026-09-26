[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$minimumNodeVersion = [Version]'22.13.0'

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList,
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory
    )

    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $FilePath @ArgumentList
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($ArgumentList -join ' ')"
        }
    }
    finally {
        Pop-Location
    }
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw 'Node.js was not found. Install Node.js 22.13 or newer, then run this script again.'
}

$nodeVersionText = (& $nodeCommand.Source --version).Trim().TrimStart('v')
if ($LASTEXITCODE -ne 0) {
    throw 'Could not determine the installed Node.js version.'
}

[Version]$nodeVersion = $null
if (-not [Version]::TryParse($nodeVersionText, [ref]$nodeVersion)) {
    throw "Could not parse the installed Node.js version: $nodeVersionText"
}
if ($nodeVersion -lt $minimumNodeVersion) {
    throw "Node.js $minimumNodeVersion or newer is required; found $nodeVersion."
}

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
    throw 'npm.cmd was not found. Reinstall Node.js with npm, then run this script again.'
}

foreach ($packageDirectory in @('web', 'collector')) {
    $path = Join-Path $repoRoot $packageDirectory
    Write-Host "Installing $packageDirectory dependencies..."
    Invoke-NativeCommand -FilePath $npmCommand.Source -ArgumentList @('ci') -WorkingDirectory $path
}

$webPath = Join-Path $repoRoot 'web'
Invoke-NativeCommand -FilePath $npmCommand.Source -ArgumentList @('run', 'local:setup') -WorkingDirectory $webPath

$devVarsPath = Join-Path $webPath '.dev.vars'
$devVars = [System.IO.File]::ReadAllText($devVarsPath)
foreach ($key in @('TYPESAFE_API_KEY', 'VOYAGE_API_KEY')) {
    if ($devVars -notmatch "(?m)^\s*$([Text.RegularExpressions.Regex]::Escape($key))\s*=") {
        if ($devVars.Length -gt 0 -and -not $devVars.EndsWith("`n")) {
            $devVars += "`r`n"
        }
        $devVars += "$key=`r`n"
    }
}
[System.IO.File]::WriteAllText($devVarsPath, $devVars, (New-Object Text.UTF8Encoding($false)))

Write-Host 'Setup complete. Add TYPESAFE_API_KEY and VOYAGE_API_KEY to web/.dev.vars for full AI, then start with: cd web; npm.cmd run local:start'
