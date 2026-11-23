/* ===== 給「馬可小幫手 → 更新批次價格」讀取「當天」的價格檔 =====
 * 加在 Apps Script 專案「每日報價自動備份」裡（和 archiveDailyQuote 同一個專案，共用
 * ARCHIVE_ROOT_FOLDER_ID、TIME_ZONE 這兩個常數）。
 *
 * 網址：GET <網路應用程式網址>?key=密碼
 *   成功 → {ok:true, name, today, created, header:[A..L 標題], rows:[[A..L], ...]}
 *   失敗 → {ok:false, error, notYet?}（notYet=true 代表今天的檔還沒產生）
 *
 * 密碼：專案設定 → 指令碼屬性 → 屬性名稱 PRICE_KEY，值由負責人自己設定。
 *       程式碼和 GitHub 都不放密碼。
 * 部署：網路應用程式，執行身分＝我，存取權＝所有人。更新程式要用
 *       「管理部署作業 → 編輯 → 新版本」，不要新增部署（網址會變）。
 */
var PRICE_SHEET_NAME = '定價';
var PRICE_COLS = 12; // A～L：商品ID … 分組價-大盤價

function doGet(e) {
  var out;
  try { out = priceFeed_((e && e.parameter) || {}); }
  catch (err) { out = { ok: false, error: String((err && err.message) || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function priceFeed_(p) {
  var key = PropertiesService.getScriptProperties().getProperty('PRICE_KEY');
  if (!key) return { ok: false, error: '還沒設定密碼（專案設定 → 指令碼屬性 PRICE_KEY）' };
  if (String(p.key || '') !== key) return { ok: false, badKey: true, error: '密碼不對' };
  return loadTodayPrices_();
}

function loadTodayPrices_() {
  var now = new Date();
  var year = Utilities.formatDate(now, TIME_ZONE, 'yyyy');
  var month = Utilities.formatDate(now, TIME_ZONE, 'M');
  var md = Utilities.formatDate(now, TIME_ZONE, 'Mdd');
  var folderName = year + '年' + month + '月報價資料';
  var fileName = '商品分組價(行政每日更新價格) ' + md + '.xlsx';

  var folders = DriveApp.getFolderById(ARCHIVE_ROOT_FOLDER_ID).getFoldersByName(folderName);
  if (!folders.hasNext()) return { ok: false, notYet: true, today: md, error: '找不到資料夾：' + folderName };
  var files = folders.next().getFilesByName(fileName);
  if (!files.hasNext()) return { ok: false, notYet: true, today: md, error: '今天的價格檔還沒產生：' + fileName };
  var file = files.next();

  var table = readXlsxSheet_(file.getBlob(), PRICE_SHEET_NAME, PRICE_COLS);
  if (table.length < 2) return { ok: false, error: '價格檔的「' + PRICE_SHEET_NAME + '」分頁是空的' };
  return {
    ok: true, name: fileName, today: md,
    created: file.getDateCreated().toISOString(),
    header: table[0], rows: table.slice(1)
  };
}

/* 讀 xlsx 裡某個分頁的前 ncols 欄（不用另外轉檔） */
function readXlsxSheet_(blob, sheetName, ncols) {
  var parts = {};
  Utilities.unzip(blob.setContentType('application/zip')).forEach(function (b) { parts[b.getName()] = b; });
  function text(name) { var b = parts[name]; return b ? b.getDataAsString('UTF-8') : ''; }
  function unesc(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(+d); }).replace(/&amp;/g, '&');
  }
  var shared = [];
  var ss = text('xl/sharedStrings.xml'), m, re = /<si>([\s\S]*?)<\/si>/g;
  while ((m = re.exec(ss))) {
    var t = '', r2 = /<t[^>]*>([\s\S]*?)<\/t>/g, mm;
    while ((mm = r2.exec(m[1]))) t += mm[1];
    shared.push(unesc(t));
  }
  var wb = text('xl/workbook.xml');
  var sm = new RegExp('<sheet [^>]*name="' + sheetName + '"[^>]*r:id="([^"]+)"').exec(wb);
  if (!sm) throw new Error('價格檔裡找不到「' + sheetName + '」分頁');
  var rels = text('xl/_rels/workbook.xml.rels');
  var tm = new RegExp('<Relationship [^>]*Id="' + sm[1] + '"[^>]*Target="([^"]+)"').exec(rels) ||
           new RegExp('<Relationship [^>]*Target="([^"]+)"[^>]*Id="' + sm[1] + '"').exec(rels);
  var path = 'xl/' + tm[1].replace(/^\/?xl\//, '');
  var xml = text(path);
  var out = [], rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g, rm;
  while ((rm = rowRe.exec(xml))) {
    var row = [], cRe = /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cm;
    for (var i = 0; i < ncols; i++) row.push('');
    while ((cm = cRe.exec(rm[1]))) {
      var col = colIndex_(cm[1]);
      if (col >= ncols) continue;
      var type = (/\bt="([^"]+)"/.exec(cm[2]) || [])[1];
      var body = cm[3] || '';
      var v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
      var val = '';
      if (type === 's') val = v != null ? shared[+v] : '';
      else if (type === 'inlineStr') { var it = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body); val = it ? unesc(it[1]) : ''; }
      else if (type === 'str' || type === 'e') val = v != null ? unesc(v) : '';
      else if (type === 'b') val = v === '1';
      else val = v != null && v !== '' ? Number(v) : '';
      row[col] = val;
    }
    if (row.some(function (x) { return x !== ''; })) out.push(row);
  }
  return out;
}

function colIndex_(letters) {
  var n = 0;
  for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

/* 在編輯器手動執行：測試讀今天的價格檔（不需要密碼） */
function testPriceFeed() {
  var r = loadTodayPrices_();
  console.log(r.ok ? ('OK ' + r.name + '：' + r.rows.length + ' 列；標題 ' + r.header.join(',')) : ('失敗：' + r.error));
}
