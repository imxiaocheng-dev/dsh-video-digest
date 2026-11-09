param(
  [Parameter(Mandatory=$true)][string]$ListFile,
  [string]$Lang = 'zh-Hans-CN'
)
# 批量 Windows OCR（内存流方案，不依赖 StorageFile，可在 DSH 沙箱内运行）
# 输出：每行一个 JSON：{"path":..,"w":..,"h":..,"ms":..,"lines":[{"t":..,"y":..,"h":..}]}
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Type]::GetType('Windows.Media.Ocr.OcrEngine, Windows, ContentType=WindowsRuntime')
$null = [Type]::GetType('Windows.Graphics.Imaging.BitmapDecoder, Windows, ContentType=WindowsRuntime')
$null = [Type]::GetType('Windows.Storage.Streams.DataWriter, Windows, ContentType=WindowsRuntime')
$null = [Type]::GetType('Windows.Storage.Streams.InMemoryRandomAccessStream, Windows, ContentType=WindowsRuntime')
$null = [Type]::GetType('Windows.Globalization.Language, Windows, ContentType=WindowsRuntime')

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function AwaitT($op, [Type]$rt) {
  $m = $asTaskGeneric.MakeGenericMethod($rt)
  $nt = $m.Invoke($null, @($op))
  $nt.Wait(-1) | Out-Null
  if ($nt.IsFaulted) { throw $nt.Exception.GetBaseException() }
  $nt.Result
}

$language = New-Object Windows.Globalization.Language $Lang
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if (-not $engine) { Write-Error "OCR engine unavailable for $Lang"; exit 2 }

function Get-Ocr([string]$path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $ms = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $w = New-Object Windows.Storage.Streams.DataWriter($ms)
  $w.WriteBytes($bytes)
  $null = AwaitT ($w.StoreAsync()) ([uint32])
  $null = AwaitT ($w.FlushAsync()) ([bool])
  $w.DetachStream() | Out-Null
  $ms.Seek(0)
  $dec = AwaitT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ms)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = AwaitT ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $res = AwaitT ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  $sw.Stop()
  $lines = @()
  foreach ($l in $res.Lines) {
    $words = @($l.Words)
    $y = 0; $h = 0
    if ($words.Count -gt 0) { $r = $words[0].BoundingRect; $y = [int][double]$r.Y; $h = [int][double]$r.Height }
    $lines += [pscustomobject]@{ t = $l.Text; y = $y; h = $h }
  }
  [pscustomobject]@{ path = $path; w = $dec.PixelWidth; h = $dec.PixelHeight; ms = [int]$sw.ElapsedMilliseconds; lines = $lines }
}

foreach ($p in (Get-Content -LiteralPath $ListFile -Encoding UTF8 | Where-Object { $_.Trim() -ne '' })) {
  try {
    $o = Get-Ocr $p
    ($o | ConvertTo-Json -Depth 6 -Compress)
  } catch {
    ([pscustomobject]@{ path = $p; error = $_.Exception.Message } | ConvertTo-Json -Compress)
  }
}
