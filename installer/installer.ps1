$ErrorActionPreference = 'Stop'
$NAME = '依車號列印'
# $LOADER（自動抓最新版的啟動器）和 $FULL（完整程式，備用）由 build 腳本定義在這行上面
$U = $LOADER

function Add-Md5 { param($md5, [byte[]]$b) [void]$md5.TransformBlock($b, 0, $b.Length, $null, 0) }
function Get-BookmarkChecksum($json) {
  $md5 = [Security.Cryptography.MD5]::Create()
  $u8 = [Text.Encoding]::UTF8; $u16 = [Text.Encoding]::Unicode
  $walk = $null
  $walk = {
    param($n)
    Add-Md5 $md5 $u8.GetBytes([string]$n.id)
    Add-Md5 $md5 $u16.GetBytes([string]$n.name)
    if ($n.type -eq 'url') {
      Add-Md5 $md5 $u8.GetBytes('url')
      Add-Md5 $md5 $u8.GetBytes([string]$n.url)
    } else {
      Add-Md5 $md5 $u8.GetBytes('folder')
      foreach ($c in @($n.children)) { if ($c) { & $walk $c } }
    }
  }
  foreach ($k in 'bookmark_bar', 'other', 'synced') { if ($json.roots.$k) { & $walk $json.roots.$k } }
  [void]$md5.TransformFinalBlock([byte[]]@(), 0, 0)
  ($md5.Hash | ForEach-Object { $_.ToString('x2') }) -join ''
}

function New-Node($id) {
  $now = [string]([DateTime]::UtcNow.ToFileTimeUtc() / 10 -as [long])
  $guid = [guid]::NewGuid().ToString()
  return "{`r`n               `"date_added`": `"$now`",`r`n               `"date_last_used`": `"0`",`r`n               `"guid`": `"$guid`",`r`n               `"id`": `"$id`",`r`n               `"name`": `"$NAME`",`r`n               `"type`": `"url`",`r`n               `"url`": `"$U`"`r`n            }"
}

function Install-Into($bmFile) {
  $utf8 = New-Object Text.UTF8Encoding($false)
  if (Test-Path $bmFile) {
    $text = [IO.File]::ReadAllText($bmFile, $utf8)
    Copy-Item $bmFile ($bmFile + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) -Force
    # 同名的書籤直接更新；舊名稱（$OLDNAMES）的書籤順便改成新名稱
    $names = @($NAME) + @($OLDNAMES | Where-Object { $_ })
    $esc = ($names | ForEach-Object { [regex]::Escape("`"name`": `"$_`"") }) -join '|'
    $re = New-Object regex ("((?:" + $esc + ")[^{}]*?`"url`": `")javascript:[^`"]*(`")")
    if ($re.IsMatch($text)) {
      $newName = "`"name`": `"$NAME`""
      $text = $re.Replace($text, { param($m) ([regex]::Replace($m.Groups[1].Value, '^"name": "[^"]*"', $newName)) + $U + $m.Groups[2].Value }, 1)
      $action = '已更新'
    } else {
      $ids = [regex]::Matches($text, '"id"\s*:\s*"(\d+)"') | ForEach-Object { [long]$_.Groups[1].Value }
      $newId = ([long](($ids | Measure-Object -Maximum).Maximum)) + 1
      $bar = [regex]::Match($text, '"bookmark_bar"\s*:\s*\{\s*"children"\s*:\s*\[')
      if (-not $bar.Success) { throw "看不懂書籤檔格式：$bmFile" }
      $pos = $bar.Index + $bar.Length
      $rest = $text.Substring($pos).TrimStart()
      $sep = if ($rest.StartsWith(']')) { '' } else { ',' }
      $text = $text.Substring(0, $pos) + ' ' + (New-Node $newId) + $sep + ' ' + $text.Substring($pos).TrimStart()
      $action = '已安裝'
    }
  } else {
    $now = [string]([DateTime]::UtcNow.ToFileTimeUtc() / 10 -as [long])
    $text = "{`r`n   `"checksum`": `"0`",`r`n   `"roots`": {`r`n      `"bookmark_bar`": {`r`n         `"children`": [ " + (New-Node 4) + " ],`r`n         `"date_added`": `"$now`",`r`n         `"date_last_used`": `"0`",`r`n         `"date_modified`": `"$now`",`r`n         `"guid`": `"0bc5d13f-2cba-5d74-951f-3f233fe6c908`",`r`n         `"id`": `"1`",`r`n         `"name`": `"書籤列`",`r`n         `"type`": `"folder`"`r`n      },`r`n      `"other`": {`r`n         `"children`": [  ],`r`n         `"date_added`": `"$now`",`r`n         `"date_last_used`": `"0`",`r`n         `"date_modified`": `"0`",`r`n         `"guid`": `"82b081ec-3dd3-529c-8475-ab6c344590dd`",`r`n         `"id`": `"2`",`r`n         `"name`": `"其他書籤`",`r`n         `"type`": `"folder`"`r`n      },`r`n      `"synced`": {`r`n         `"children`": [  ],`r`n         `"date_added`": `"$now`",`r`n         `"date_last_used`": `"0`",`r`n         `"date_modified`": `"0`",`r`n         `"guid`": `"4cf2e351-0e85-532b-bb37-df045d8f8d0f`",`r`n         `"id`": `"3`",`r`n         `"name`": `"行動書籤`",`r`n         `"type`": `"folder`"`r`n      }`r`n   },`r`n   `"version`": 1`r`n}`r`n"
    $action = '已安裝'
  }
  $json = $text | ConvertFrom-Json
  $sum = Get-BookmarkChecksum $json
  $text = [regex]::Replace($text, '"checksum"\s*:\s*"[0-9a-fA-F]*"', "`"checksum`": `"$sum`"", 1)
  [IO.File]::WriteAllText($bmFile, $text, $utf8)
  # 新版 Chrome 會優先讀加密副本（EncryptedBookmarks2），先把它改名保留，
  # Chrome 下次開啟會改讀一般書籤檔，再自動產生新的加密副本。
  $dir = Split-Path $bmFile
  $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
  foreach ($e in 'EncryptedBookmarks2', 'EncryptedBookmarks2.bak', 'EncryptedBookmarks') {
    $ep = Join-Path $dir $e
    if (Test-Path $ep) { Rename-Item $ep ($e + '.before-mk-' + $ts) }
  }
  return $action
}

function Show-BookmarkBar($prefFile) {
  if (-not (Test-Path $prefFile)) { return }
  $utf8 = New-Object Text.UTF8Encoding($false)
  $p = [IO.File]::ReadAllText($prefFile, $utf8)
  if ($p -match '"show_on_all_tabs":false') {
    [IO.File]::WriteAllText($prefFile, ($p -replace '"show_on_all_tabs":false', '"show_on_all_tabs":true'), $utf8)
  }
}

# ---------------- main ----------------
$test = $env:MK_TEST_DIR
Write-Host ''
Write-Host '======================================' -ForegroundColor Green
Write-Host '   安裝「馬可小幫手」書籤到 Chrome' -ForegroundColor Green
Write-Host '======================================' -ForegroundColor Green
Write-Host ''

if (-not $test) {
  while (Get-Process chrome -ErrorAction SilentlyContinue) {
    Write-Host 'Chrome 還開著。請先把所有 Chrome 視窗關掉，然後按 Enter 鍵。' -ForegroundColor Yellow
    Write-Host '（如果已經關掉了還是一直出現這段話，請輸入 Y 再按 Enter，我會幫你把 Chrome 關掉）' -ForegroundColor DarkGray
    $a = Read-Host
    if ($a -match '^[Yy]') { Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }
  }
  $ud = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
} else { $ud = $test }

if (-not (Test-Path $ud)) { Write-Host '這台電腦找不到 Chrome，請先安裝 Google Chrome。' -ForegroundColor Red; return }

$profiles = Get-ChildItem $ud -Directory | Where-Object { ($_.Name -eq 'Default' -or $_.Name -like 'Profile *') -and (Test-Path (Join-Path $_.FullName 'Preferences')) }
if (-not $profiles) { Write-Host '找不到 Chrome 使用者資料，請先打開 Chrome 一次再執行。' -ForegroundColor Red; return }

$ok = 0
foreach ($pr in $profiles) {
  try {
    $bm = Join-Path $pr.FullName 'Bookmarks'
    # 先放備用（完整程式），再放主書籤（自動抓最新版），主書籤會在最左邊
    $NAME = '依車號列印（備用）'; $U = $FULL; $OLDNAMES = @()
    $r2 = Install-Into $bm
    $NAME = '馬可小幫手'; $U = $LOADER; $OLDNAMES = @('依車號列印')
    $r = Install-Into $bm
    Show-BookmarkBar (Join-Path $pr.FullName 'Preferences')
    Write-Host ("  [{0}] 馬可小幫手：{1}　備用：{2}" -f $pr.Name, $r, $r2) -ForegroundColor Green
    $ok++
  } catch {
    Write-Host ("  [{0}] 失敗：{1}" -f $pr.Name, $_.Exception.Message) -ForegroundColor Red
  }
}

Write-Host ''
if ($ok -gt 0) {
  Write-Host '完成！現在打開 Chrome，書籤列最左邊會出現「馬可小幫手」。' -ForegroundColor Green
  if (-not $test) { try { Start-Process 'chrome' } catch {} }
}
