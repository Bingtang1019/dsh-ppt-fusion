# Open .pptx files in PowerPoint through COM, read the slide count, and close.
#
# This is the Windows deliverable gate from the plan: a package that PowerPoint
# refuses or repairs is not a deliverable, whatever the ZIP-level audit says.
#
# Usage:
#   pwsh -File scripts/win-com-smoke.ps1 -Path out/deck.pptx
#   pwsh -File scripts/win-com-smoke.ps1 -Path a.pptx,b.pptx -ExpectedSlides 5 -Json
param(
    [Parameter(Mandatory = $true)][string[]]$Path,
    [int]$ExpectedSlides = 0,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$msoTrue = -1
$msoFalse = 0
$results = @()
$app = $null
# Stale POWERPNT processes (from a killed run) make COM activation fail with
# CO_E_SERVER_EXEC_FAILURE or hang behind a recovery prompt, so clear them first
# and retry once; both were observed on this machine while building M4.
Get-Process POWERPNT -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
for ($attempt = 1; $attempt -le 3 -and $null -eq $app; $attempt++) {
    try {
        $app = New-Object -ComObject PowerPoint.Application
    }
    catch {
        if ($attempt -eq 3) { $activationError = $_ }
        else { Start-Sleep -Seconds 10 }
    }
}
if ($null -eq $app) { $_ = $activationError }
try {
    if ($null -eq $app) { throw $_ }
}
catch {
    $message = "cannot start PowerPoint COM: $($_.Exception.Message)"
    if ($Json) {
        @{ ok = $false; error = $message; decks = @() } | ConvertTo-Json -Depth 5
    }
    else {
        Write-Error $message
    }
    exit 1
}

foreach ($item in $Path) {
    $full = (Resolve-Path -LiteralPath $item).Path
    $before = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash
    $deck = $null
    $record = [ordered]@{ path = $full; ok = $false }
    try {
        # ReadOnly, Untitled, WithWindow = false so the smoke run stays headless.
        $deck = $app.Presentations.Open($full, $msoTrue, $msoFalse, $msoFalse)
        $record.slides = $deck.Slides.Count
        $record.width = $deck.PageSetup.SlideWidth
        $record.height = $deck.PageSetup.SlideHeight
        # A package PowerPoint had to repair arrives dirty; a clean open stays saved.
        $record.saved = ($deck.Saved -eq $msoTrue)
        $record.ok = $true
        if (-not $record.saved) {
            $record.ok = $false
            $record.error = 'PowerPoint marked the opened deck as modified, which indicates a repair'
        }
        elseif ($ExpectedSlides -gt 0 -and $record.slides -ne $ExpectedSlides) {
            $record.ok = $false
            $record.error = "expected $ExpectedSlides slides, opened $($record.slides)"
        }
    }
    catch {
        $record.error = $_.Exception.Message
    }
    finally {
        if ($null -ne $deck) {
            try { $deck.Close() } catch { }
        }
    }
    # PowerPoint must not rewrite the file when it opens it.
    $after = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash
    $record.unchanged = ($before -eq $after)
    if (-not $record.unchanged) {
        $record.ok = $false
        $record.error = "$($record.error); file bytes changed during open/close"
    }
    $results += $record
}

try { $app.Quit() } catch { }

$failed = @($results | Where-Object { -not $_.ok })
if ($Json) {
    @{ ok = ($failed.Count -eq 0); decks = $results } | ConvertTo-Json -Depth 5
}
else {
    foreach ($record in $results) {
        $status = if ($record.ok) { 'OK' } else { 'FAIL' }
        $detail = if ($record.ok) { "$($record.slides) slides" } else { $record.error }
        Write-Host "[$status] $($record.path) - $detail"
    }
}
if ($failed.Count -gt 0) { exit 1 }
