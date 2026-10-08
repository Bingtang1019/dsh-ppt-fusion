# Export every slide of a deck to PNG through PowerPoint COM (Windows only).
#
# `dsh-ppt renderpages --engine powerpoint` runs this as its PowerPoint leg: the
# LibreOffice Kit covers CI and non-Windows hosts, and this script supplies the
# "real PowerPoint" evidence on the machine that has Office installed.
#
# Two PowerPoint behaviours are handled here rather than left to the caller
# (feedback F7, ADR-101):
#   * `Slide.Export` returns before the PNG is flushed, so a file is accepted only
#     after its signature, IHDR dimensions and trailing IEND chunk are all present,
#     with up to three export attempts;
#   * PowerPoint caches an open presentation by path, so a re-export of a modified
#     deck can hand back the old in-memory copy; every run opens a unique copy of
#     the deck, which removes the path identity that cache keys on.
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
# PNG signature and the IEND chunk a complete file ends with.
$pngSignature = [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
$pngIend = [byte[]](0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82)

function Test-PngComplete([string]$Path, [int]$Width, [int]$Height) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        $bytes = [IO.File]::ReadAllBytes($Path)
    }
    catch {
        return $false
    }
    if ($bytes.Length -lt 45) { return $false }
    for ($i = 0; $i -lt $pngSignature.Length; $i++) {
        if ($bytes[$i] -ne $pngSignature[$i]) { return $false }
    }
    # IHDR is the first chunk: width and height are big-endian 32-bit at offsets 16 and 20.
    # `-shl` returns the LEFT operand's type, and a byte cannot hold bits above 8, so every
    # operand is widened to [int] first — without the cast the width reads as 0.
    $fileWidth = ([int]$bytes[16] -shl 24) -bor ([int]$bytes[17] -shl 16) -bor ([int]$bytes[18] -shl 8) -bor [int]$bytes[19]
    $fileHeight = ([int]$bytes[20] -shl 24) -bor ([int]$bytes[21] -shl 16) -bor ([int]$bytes[22] -shl 8) -bor [int]$bytes[23]
    # PowerPoint may round the export size by a pixel or two against the requested size; the
    # tolerance accepts that while still refusing a header whose dimensions make no sense.
    if ([Math]::Abs($fileWidth - $Width) -gt 2 -or [Math]::Abs($fileHeight - $Height) -gt 2) { return $false }
    $tail = $bytes[($bytes.Length - $pngIend.Length)..($bytes.Length - 1)]
    for ($i = 0; $i -lt $pngIend.Length; $i++) {
        if ($tail[$i] -ne $pngIend[$i]) { return $false }
    }
    return $true
}

function Wait-PngComplete([string]$Path, [int]$Width, [int]$Height, [int]$TimeoutMs = 3000) {
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    $delay = 60
    while ((Get-Date) -lt $deadline) {
        if (Test-PngComplete -Path $Path -Width $Width -Height $Height) { return $true }
        Start-Sleep -Milliseconds $delay
        if ($delay -lt 480) { $delay = $delay * 2 }
    }
    return (Test-PngComplete -Path $Path -Width $Width -Height $Height)
}

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
$workingCopy = $null
$result = [ordered]@{ ok = $false; engineVersion = $null; pageCount = 0; width = 0; height = 0; pages = @() }
try {
    $full = (Resolve-Path -LiteralPath $Deck).Path
    $result.engineVersion = [string]$app.Version
    # A unique copy per run defeats PowerPoint's by-path presentation cache, which
    # otherwise serves a stale in-memory copy when the caller re-exports a deck it
    # just modified (the feedback report saw 10 of 16 pages come back stale).
    $workingCopy = Join-Path ([IO.Path]::GetTempPath()) ('com-export-' + [guid]::NewGuid().ToString('N') + '.pptx')
    Copy-Item -LiteralPath $full -Destination $workingCopy -Force
    # ReadOnly = true, Untitled = false, WithWindow = false keeps the run headless
    # and guarantees the file is not rewritten (the delivery gate checks bytes).
    $presentation = $app.Presentations.Open($workingCopy, $msoTrue, $msoFalse, $msoFalse)
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
    $exportAttempts = 0
    for ($i = 1; $i -le $count; $i++) {
        $file = Join-Path $OutDir ('page-{0:d4}.png' -f $i)
        # Export fails when the target exists, so clear our own page file first; a
        # leftover from an earlier run must never be mistaken for this run's output.
        $complete = $false
        for ($attempt = 1; $attempt -le 3 -and -not $complete; $attempt++) {
            if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
            $presentation.Slides.Item($i).Export($file, 'PNG', $width, $height)
            $exportAttempts += 1
            $complete = Wait-PngComplete -Path $file -Width $width -Height $height
            if (-not $complete) { Start-Sleep -Milliseconds (150 * $attempt) }
        }
        if (-not $complete) {
            throw "PowerPoint wrote an incomplete PNG for slide $i after 3 attempts ($file); rerun with --engine libreoffice for a structural render"
        }
        $pages += [ordered]@{ index = $i; file = (Split-Path -Leaf $file) }
    }
    $result.pages = $pages
    $result.exportAttempts = $exportAttempts
    $result.ok = $true
}
catch {
    $result.ok = $false
    $result.error = "$($_.Exception.Message) [line $($_.InvocationInfo.ScriptLineNumber): $($_.InvocationInfo.Line.Trim())]"
}
finally {
    if ($null -ne $presentation) { try { $presentation.Close() } catch { } }
    try { $app.Quit() } catch { }
    if ($null -ne $workingCopy) { Remove-Item -LiteralPath $workingCopy -Force -ErrorAction SilentlyContinue }
}

Write-Result $result $result.ok
if (-not $result.ok) { exit 1 }