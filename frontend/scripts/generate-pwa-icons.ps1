# ============================================================================
# توليد أيقونات PWA لتطبيق "نبض | إدارة العيادات"
# ----------------------------------------------------------------------------
# يولّد أيقونات PNG حقيقية من هوية النظام نفسها:
#   خلفية #173c3d (لون الشريط الجانبي) + مربع #df8b67 (علامة العلامة) + حرف "ن"
# الاستخدام:  powershell -ExecutionPolicy Bypass -File frontend/scripts/generate-pwa-icons.ps1
# الإخراج:    frontend/public/icons/*.png
# ============================================================================
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$outDir = Join-Path $PSScriptRoot '..\public\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$teal   = '#173c3d'
$orange = '#df8b67'
$white  = '#ffffff'
# ملاحظة مهمة: نكتب الحرف بنقطة الترميز Unicode وليس كنص عربي مباشر،
# لأن PowerShell 5.1 يقرأ ملفات .ps1 بدون BOM بترميز ANSI فيُفسد الحرف العربي.
$letter = [string][char]0x0646   # الحرف العربي "ن"

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

# قياس حدود الرسم الفعلية للحرف (ink bounds) — يُستخدم لضبط الحجم والتوسيط البصري
function Get-LetterInk {
  param([string]$Text, [string]$Family, [int]$Probe = 220, [double]$FontRatio = 0.64)

  $tmp = New-Object System.Drawing.Bitmap($Probe, $Probe, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $tg = [System.Drawing.Graphics]::FromImage($tmp)
  $tg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $tg.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $font = New-Object System.Drawing.Font($Family, [single]($Probe * $FontRatio), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF(0, 0, $Probe, $Probe)
  $tg.DrawString($Text, $font, [System.Drawing.Brushes]::Black, $rect, $fmt)

  $minX = $Probe; $minY = $Probe; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $Probe; $y++) {
    for ($x = 0; $x -lt $Probe; $x++) {
      if ($tmp.GetPixel($x, $y).A -gt 12) {
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  $tg.Dispose(); $font.Dispose(); $fmt.Dispose(); $tmp.Dispose()

  if ($maxX -lt 0) { return @{ Height = 0.0; CenterX = 0.0; CenterY = 0.0 } }
  $probeCenter = ($Probe - 1) / 2.0
  return @{
    Height  = [double]($maxY - $minY + 1)
    CenterX = [double](($minX + $maxX) / 2.0 - $probeCenter)   # إزاحة مركز الحبر عند مقاس القياس
    CenterY = [double](($minY + $maxY) / 2.0 - $probeCenter)
  }
}

function New-NabdIcon {
  param(
    [int]$Size,
    [string]$File,
    [double]$MarkRatio = 0.66,   # نسبة حجم المربع البرتقالي إلى الأيقونة
    [double]$MarkRadius = 0.28,  # استدارة المربع البرتقالي
    [bool]$RoundedCanvas = $true,
    [double]$LetterRatio = 0.64,  # نسبة حجم الخط الأولية إلى المربع البرتقالي
    [double]$TargetInkHeight = 0.52,  # ارتفاع حبر الحرف المستهدف من المربع البرتقالي
    [string]$FontFamily = 'Segoe UI'
  )

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($teal))
  if ($RoundedCanvas) {
    $bgPath = New-RoundedPath 0 0 $Size $Size ($Size * 0.22)
    $g.FillPath($bgBrush, $bgPath)
    $bgPath.Dispose()
  } else {
    $g.FillRectangle($bgBrush, 0, 0, $Size, $Size)
  }

  $markSize = [single]($Size * $MarkRatio)
  $markX = [single](($Size - $markSize) / 2)
  $markY = [single](($Size - $markSize) / 2)
  $markBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($orange))
  $markPath = New-RoundedPath $markX $markY $markSize $markSize ([single]($markSize * $MarkRadius))
  $g.FillPath($markBrush, $markPath)
  $markPath.Dispose()

  # ضبط الحرف بصرياً: تحديد ارتفاع الحبر المستهدف ثم توسيط حبر الحرف فعلياً داخل المربع
  $probe = 220
  $ink = Get-LetterInk -Text $letter -Family $FontFamily -Probe $probe -FontRatio $LetterRatio
  $scale = if ($ink.Height -gt 0) { ($markSize * $TargetInkHeight) / $ink.Height } else { 1.0 }
  $fontPx = [single](($probe * $LetterRatio) * $scale)
  $font = New-Object System.Drawing.Font($FontFamily, $fontPx, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel))
  $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($white))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  # إشارة معاكسة لإزاحة الحبر حتى يقف مركز الحبر على مركز المربع البرتقالي
  $dx = [single](-1 * $ink.CenterX * $scale)
  $dy = [single](-1 * $ink.CenterY * $scale)
  $rect = New-Object System.Drawing.RectangleF(($markX + $dx), ($markY + $dy), $markSize, $markSize)
  $g.DrawString($letter, $font, $textBrush, $rect, $fmt)

  $bmp.Save($File, [System.Drawing.Imaging.ImageFormat]::Png)

  $font.Dispose(); $fmt.Dispose(); $textBrush.Dispose(); $markBrush.Dispose(); $bgBrush.Dispose()
  $g.Dispose(); $bmp.Dispose()
  Write-Host ("created: " + $File)
}

# أيقونات العرض العادي (any) بحواف مستديرة
New-NabdIcon -Size 192 -File (Join-Path $outDir 'icon-192.png') -MarkRatio 0.66 -RoundedCanvas $true
New-NabdIcon -Size 512 -File (Join-Path $outDir 'icon-512.png') -MarkRatio 0.66 -RoundedCanvas $true
# أيقونات maskable: خلفية كاملة الحواف والمحتوى داخل المنطقة الآمنة (80%)
New-NabdIcon -Size 192 -File (Join-Path $outDir 'icon-maskable-192.png') -MarkRatio 0.56 -RoundedCanvas $false
New-NabdIcon -Size 512 -File (Join-Path $outDir 'icon-maskable-512.png') -MarkRatio 0.56 -RoundedCanvas $false
# أيقونة iOS (النظام يطبق القناع بنفسه)
New-NabdIcon -Size 180 -File (Join-Path $outDir 'apple-touch-icon-180.png') -MarkRatio 0.62 -RoundedCanvas $false
# أيقونة المتصفح الصغيرة
New-NabdIcon -Size 32 -File (Join-Path $outDir 'icon-32.png') -MarkRatio 0.7 -MarkRadius 0.3 -RoundedCanvas $true -LetterRatio 0.66