// 重做安裝檔「安裝馬可小幫手.bat」
// 用法（在專案資料夾執行）：node installer/build-bat.js
//   也可以指定程式網址：node installer/build-bat.js https://<帳號>.github.io/<repo>/mk.js
// 產生：
//   installer/安裝馬可小幫手.bat   傳給各台電腦點兩下安裝
//   installer/loader-url.txt       「馬可小幫手」書籤的網址（手動新增書籤時用）
// 安裝檔會裝兩個書籤：
//   馬可小幫手          啟動器：每次按都去 GitHub Pages 抓最新的 mk.js（以後改程式不用重裝）
//   依車號列印（備用）  完整的出貨單程式（安裝當時的 print.js），GitHub 連不上時用
const fs = require('fs');
const path = require('path');
const scriptUrl = process.argv[2] || 'https://david840822-create.github.io/marco-tools/mk.js';
if (!/^https:\/\/[\w.-]+\/.+\.js$/.test(scriptUrl)) throw new Error('程式網址格式不對，例如 https://xxx.github.io/marco-tools/mk.js');
const here = __dirname;
const src = fs.readFileSync(path.join(here, '..', 'print.js'), 'utf8');
const enc = s => ('javascript:' + encodeURIComponent(s)).replace(/'/g, '%27');
const full = enc(src + ';void 0;');
// 啟動器：每次按都抓網路上最新版（加時間參數避免讀到舊的快取）
const loaderSrc = "(function(){var s=document.createElement('script');"
  + "s.src='" + scriptUrl + "?t='+Date.now();"
  + "s.onerror=function(){alert('連不到最新版程式，請改按書籤列上的「依車號列印（備用）」');};"
  + "document.body.appendChild(s);})();void 0;";
const loader = enc(loaderSrc);
const header = [
  '@echo off',
  'title 安裝 馬可小幫手',
  "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$s=[IO.File]::ReadAllText('%~f0',[Text.Encoding]::UTF8); $i=$s.IndexOf('#'+'#PS-START'); Invoke-Expression $s.Substring($i)\"",
  'echo.',
  'pause',
  'exit /b',
  '##PS-START',
  "$LOADER = '" + loader + "'",
  "$FULL = '" + full + "'",
].join('\r\n');
const ps = fs.readFileSync(path.join(here, 'installer.ps1'), 'utf8').replace(/\r?\n/g, '\r\n');
fs.writeFileSync(path.join(here, '安裝馬可小幫手.bat'), header + '\r\n' + ps);
fs.writeFileSync(path.join(here, 'loader-url.txt'), loader);
console.log('安裝檔', fs.statSync(path.join(here, '安裝馬可小幫手.bat')).size, 'bytes；書籤網址', loader.length, '字');
