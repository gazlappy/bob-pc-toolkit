# Composes build/splash.bmp — the image the portable launcher shows while it
# extracts, so startup never looks like a blank screen. Built from the BOB icon
# plus the wordmark. Run:  powershell -File tools/make-splash.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$W = 460; $H = 300
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$g.Clear([System.Drawing.Color]::FromArgb(14, 17, 22))

# Subtle blue glow from the top.
$glow = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point 0, 0),
  (New-Object System.Drawing.Point 0, $H),
  ([System.Drawing.Color]::FromArgb(55, 63, 111, 218)),
  ([System.Drawing.Color]::FromArgb(0, 14, 17, 22)))
$g.FillRectangle($glow, 0, 0, $W, $H)

# The BOB star icon.
$icon = [System.Drawing.Image]::FromFile((Join-Path $root 'build/icon.png'))
$iw = 118; $ih = 118
$g.DrawImage($icon, [int](($W - $iw) / 2), 34, $iw, $ih)

$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$faint = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 160, 175))
$fBob = New-Object System.Drawing.Font 'Segoe UI', 28, ([System.Drawing.FontStyle]::Bold)
$fTag = New-Object System.Drawing.Font 'Segoe UI', 9.5, ([System.Drawing.FontStyle]::Bold)
$fLoad = New-Object System.Drawing.Font 'Segoe UI', 10.5, ([System.Drawing.FontStyle]::Regular)
$g.DrawString('BOB', $fBob, $white, [single]($W / 2), [single]168, $sf)
$g.DrawString('B E S T   O F   T H E   B E S T', $fTag, $faint, [single]($W / 2), [single]214, $sf)
$g.DrawString('Starting' + [char]0x2026, $fLoad, $faint, [single]($W / 2), [single]250, $sf)

$g.Dispose()
$out = Join-Path $root 'build/splash.bmp'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Bmp)
$bmp.Dispose()
Write-Host ("wrote " + $out + " (" + $W + "x" + $H + ")")
