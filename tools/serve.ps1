# PowerShell fallback static server (used by start_game.bat when neither Python nor Node.js is installed).
# Works on stock Windows 10/11 (Windows PowerShell 5.1).
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$mime = @{
  '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.mjs'='text/javascript; charset=utf-8';
  '.css'='text/css; charset=utf-8'; '.json'='application/json'; '.glb'='model/gltf-binary'; '.gltf'='model/gltf+json';
  '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.svg'='image/svg+xml'; '.ico'='image/x-icon';
  '.mp3'='audio/mpeg'; '.ogg'='audio/ogg'; '.wav'='audio/wav'; '.bin'='application/octet-stream'; '.txt'='text/plain'
}
$listener = $null
$port = 8765
for ($p = 8765; $p -lt 8800; $p++) {
  try {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$p/")
    $l.Start()
    $listener = $l; $port = $p; break
  } catch { }
}
if (-not $listener) { Write-Host 'Could not open a local port.'; exit 1 }
$url = "http://localhost:$port/"
Write-Host '============================================================'
Write-Host '  ASPHALT FOREST - racing game server running'
Write-Host "  Open: $url"
Write-Host '  (Close this window to stop the game server)'
Write-Host '============================================================'
Start-Process $url
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  try {
    $path = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($path -eq '/api/cars') {
      $files = @()
      $carDir = Join-Path $root 'cars'
      if (Test-Path $carDir) { $files = @(Get-ChildItem $carDir -Filter '*.glb' | Sort-Object Name | ForEach-Object { $_.Name }) }
      $json = ConvertTo-Json -InputObject $files -Compress
      if ($files.Count -eq 0) { $json = '[]' }
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
      $res.ContentType = 'application/json'
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      if ($path.EndsWith('/')) { $path += 'index.html' }
      $rel = $path.TrimStart('/').Replace('/', '\')
      $file = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
      if (-not $file.StartsWith($root) -or -not (Test-Path $file -PathType Leaf)) {
        $res.StatusCode = 404
      } else {
        $ext = [System.IO.Path]::GetExtension($file).ToLower()
        if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] } else { $res.ContentType = 'application/octet-stream' }
        $res.Headers.Add('Cache-Control', 'no-cache')
        $bytes = [System.IO.File]::ReadAllBytes($file)
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      }
    }
  } catch { try { $res.StatusCode = 500 } catch { } }
  finally { try { $res.OutputStream.Close() } catch { } }
}
