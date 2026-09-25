# Export every slide of a deck to PNG through PowerPoint COM (Windows only).
#
# `dsh-ppt renderpages --engine powerpoint` runs this as its PowerPoint leg: the
# 0.1.7 LibreOffice Kit covers CI and non-Windows hosts, and this script supplies
# the "real PowerPoint" evidence on the machine that has Office installed.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/win-com-export-pages.ps1 `
#     -Deck <absolute.pptx> -OutDir <absolute empty dir> [-Dpi 96] [-MaxPages 30] [-Json]
#
# Writes page-<n>.png (four-digit index, matching the LibreOffice Kit naming) and
# prints one JSON object: { ok, engineVersion, pageCount, width, height, pages[] }.
# Failures print { ok = false, error } and exit 1; the caller classifies them.
param(
    [Parameter(Mandatory = $true)][string]$Deck,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [int]$Dpi = 96,
    [int]$MaxPages = 30,
    [int]$MaxPixels = 16777216,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$msoTrue = -1
$msoFalse = 0

function Write-Result($result, $ok) {
    if ($Json) {
        $result | ConvertTo-Json -Depth 6 -Compress
    }
    else {
        if ($ok) { Write-Host "exported $($result.pageCount) slide(s) to $OutDir" }
        else { Write-Error $result.error }
    }
}

if (-not (Test-Path -LiteralPath $Deck -PathType Leaf)) {
    Write-Result @{ ok = $false; error = "deck not found: $Deck" } $false
    exit 1
}
if (-not (Test-Path -LiteralPath $OutDir -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}

$app = $null
# Two activation attempts without killing a user's PowerPoint: a stale POWERPNT
# from a crashed run fails activation with CO_E_SERVER_EXEC_FAILURE, and a second
# attempt after a short pause recovers in most cases.
for ($attempt = 1; $attempt -le 2 -and $null -eq $app; $attempt++) {
    try {
        $app = New-Object -ComObject PowerPoint.Application
    }
    catch {
        if ($attempt -eq 2) {
            Write-Result @{ ok = $false; error = "cannot start PowerPoint COM: $($_.Exception.Message)" } $false
            exit 1
        }
        Start-Sleep -Seconds 5
    }
}

$presentation = $null
$result = [ordered]@{ ok = $false; engineVersion = $null; pageCount = 0; width = 0; height = 0; pages = @() }
try {
    $full = (Resolve-Path -LiteralPath $Deck).Path
    $result.engineVersion = [string]$app.Version
    # ReadOnly = true, Untitled = false, WithWindow = false keeps the run headless
    # and guarantees the file is not rewritten (the delivery gate checks bytes).
    $presentation = $app.Presentations.Open($full, $msoTrue, $msoFalse, $msoFalse)
    $slideWidthPt = [double]$presentation.PageSetup.SlideWidth
    $slideHeightPt = [double]$presentation.PageSetup.SlideHeight
    $width = [int][Math]::Round($slideWidthPt * $Dpi / 72.0)
    $height = [int][Math]::Round($slideHeightPt * $Dpi / 72.0)
    $count = [int]$presentation.Slides.Count
    if ($count -gt $MaxPages) {
        throw "the deck has $count slide(s), above the --max-pages limit $MaxPages"
    }
    if ($width * $height -gt $MaxPixels) {
        throw "a page at DPI $Dpi is $width x $height, above the --max-pixels limit $MaxPixels"
    }
    $result.pageCount = $count
    $result.width = $width
    $result.height = $height
    $pages = @()
    for ($i = 1; $i -le $count; $i++) {
        $file = Join-Path $OutDir ('page-{0:d4}.png' -f $i)
        # Export writes the file itself and fails when the target exists, so clear
        # only our own page file (the caller hands us a fresh directory anyway).
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
        $presentation.Slides.Item($i).Export($file, 'PNG', $width, $height)
        if (-not (Test-Path -LiteralPath $file)) { throw "PowerPoint exported no file for slide $i" }
        $pages += [ordered]@{ index = $i; file = (Split-Path -Leaf $file) }
    }
    $result.pages = $pages
    $result.ok = $true
}
catch {
    $result.ok = $false
    $result.error = "$($_.Exception.Message) [line $($_.InvocationInfo.ScriptLineNumber): $($_.InvocationInfo.Line.Trim())]"
}
finally {
    if ($null -ne $presentation) { try { $presentation.Close() } catch { } }
    try { $app.Quit() } catch { }
}

Write-Result $result $result.ok
if (-not $result.ok) { exit 1 }
