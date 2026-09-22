# Read a deck's animation sequence back through PowerPoint COM.
#
# This is the automated half of acceptance S7: a package can carry
# `p:transition`/`p:timing` XML and still show nothing in PowerPoint, so the gate
# asks PowerPoint itself what it parsed -- `Slide.TimeLine.MainSequence.Count` and
# each effect's `EffectType` are exactly what the animation pane displays.
#
# Usage: pwsh -File scripts/win-com-anim-probe.ps1 -Path out/deck.pptx [-Json]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$Json
)
$ErrorActionPreference = 'Stop'
Get-Process POWERPNT -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$app = $null
for ($attempt = 1; $attempt -le 3 -and $null -eq $app; $attempt++) {
    try { $app = New-Object -ComObject PowerPoint.Application } catch { Start-Sleep -Seconds 10 }
}
if ($null -eq $app) { Write-Error 'cannot start PowerPoint COM'; exit 1 }
$full = (Resolve-Path -LiteralPath $Path).Path
$deck = $app.Presentations.Open($full, -1, 0, 0)
$rows = @()
try {
    foreach ($i in 1..$deck.Slides.Count) {
        $slide = $deck.Slides.Item($i)
        $seq = $slide.TimeLine.MainSequence
        $effects = @()
        for ($e = 1; $e -le $seq.Count; $e++) { $effects += $seq.Item($e).EffectType }
        $rows += [ordered]@{
            slide         = $i
            effects       = $seq.Count
            effectTypes   = $effects
            entryEffect   = $slide.SlideShowTransition.EntryEffect
        }
    }
}
finally {
    $deck.Close()
    $app.Quit()
}
if ($Json) { @{ path = $full; slides = $rows } | ConvertTo-Json -Depth 5 }
else { foreach ($row in $rows) { Write-Host ("slide {0}: effects={1} types={2} entryEffect={3}" -f $row.slide, $row.effects, ($row.effectTypes -join ','), $row.entryEffect) } }