/* ===== 給「馬可小幫手 → 更新批次價格」列出／讀取價格檔 =====
 * 加在 Apps Script 專案「每日報價自動備份」裡（和 archiveDailyQuote 同一個專案，共用
 * ARCHIVE_ROOT_FOLDER_ID、TIME_ZONE 這兩個常數）。
 *
 * 網址（都要帶 key=密碼）：
 *   ?action=list → {ok, today:'yyyy-MM-dd'（作業日：凌晨 0～6 點算前一天）, files:[{id, name, date:'yyyy-MM-dd'}]}（最新在前，最多 15 個）
 *   ?id=檔案ID   → {ok, name, date, header:[A..L 標題], rows:[[A..L], ...]}（只接受報價資料夾裡的價格檔）
 *   失敗 → {ok:false, error, badKey?}
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
  if (p.action === 'list') return listPriceFiles_();
  if (p.id) return loadPriceFile_(p.id);
  return loadTodayPrices_();
}

var PRICE_FILE_RE = /^商品分組價\(行政每日更新價格\) (\d{3,4})\.xlsx$/;
var MONTH_FOLDER_RE = /^(\d{4})年(\d{1,2})月報價資料$/;

/* 作業日：凌晨 0～6 點算前一天 */
function workDay_() {
  var now = new Date();
  if (Number(Utilities.formatDate(now, TIME_ZONE, 'H')) < 6) now = new Date(now.getTime() - 6 * 3600 * 1000);
  return now;
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/* 價格檔名的日期（Mdd）＋ 月資料夾的年份 → yyyy-MM-dd */
function fileDate_(folderName, fileName) {
  var fm = MONTH_FOLDER_RE.exec(folderName), nm = PRICE_FILE_RE.exec(fileName);
  if (!fm || !nm) return '';
  var md = nm[1];
  return fm[1] + '-' + pad2_(Number(md.slice(0, -2))) + '-' + md.slice(-2);
}

/* 列出這個月＋上個月的價格檔（最新在前） */
function listPriceFiles_() {
  var wd = workDay_();
  var y = Number(Utilities.formatDate(wd, TIME_ZONE, 'yyyy')), m = Number(Utilities.formatDate(wd, TIME_ZONE, 'M'));
  var root = DriveApp.getFolderById(ARCHIVE_ROOT_FOLDER_ID), files = [];
  for (var back = 0; back < 2; back++) {
    var yy = y, mm = m - back;
    if (mm < 1) { mm += 12; yy--; }
    var folderName = yy + '年' + mm + '月報價資料';
    var it = root.getFoldersByName(folderName);
    while (it.hasNext()) {
      var fit = it.next().getFiles();
      while (fit.hasNext()) {
        var f = fit.next(), name = f.getName();
        if (!PRICE_FILE_RE.test(name)) continue;
        files.push({ id: f.getId(), name: name, date: fileDate_(folderName, name) });
      }
    }
  }
  files.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  return { ok: true, today: Utilities.formatDate(wd, TIME_ZONE, 'yyyy-MM-dd'), files: files.slice(0, 15) };
}

/* 讀指定的價格檔（只接受報價根資料夾底下月資料夾裡、檔名符合的檔） */
function loadPriceFile_(id) {
  var file;
  try { file = DriveApp.getFileById(id); } catch (e) { return { ok: false, error: '找不到這個價格檔' }; }
  var name = file.getName();
  if (!PRICE_FILE_RE.test(name)) return { ok: false, error: '這不是價格檔：' + name };
  var parents = file.getParents(), folderName = '';
  while (parents.hasNext()) {
    var pf = parents.next(), gp = pf.getParents();
    while (gp.hasNext()) if (gp.next().getId() === ARCHIVE_ROOT_FOLDER_ID && MONTH_FOLDER_RE.test(pf.getName())) folderName = pf.getName();
  }
  if (!folderName) return { ok: false, error: '這個檔不在報價資料夾裡：' + name };
  var table = readXlsxSheet_(file.getBlob(), PRICE_SHEET_NAME, PRICE_COLS);
  if (table.length < 2) return { ok: false, error: '價格檔的「' + PRICE_SHEET_NAME + '」分頁是空的' };
  return { ok: true, id: id, name: name, date: fileDate_(folderName, name), header: table[0], rows: table.slice(1) };
}

function loadTodayPrices_() {
  var now = workDay_();
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

/* 在編輯器手動執行：測試列出價格檔＋讀最新一個（不需要密碼，不會改任何東西） */
function testPriceFeed() {
  var l = listPriceFiles_();
  console.log('作業日 ' + l.today + '，價格檔：' + l.files.map(function (f) { return f.date; }).join('、'));
  if (!l.files.length) return;
  var r = loadPriceFile_(l.files[0].id);
  console.log(r.ok ? ('OK ' + r.name + '（' + r.date + '）：' + r.rows.length + ' 列；標題 ' + r.header.join(',')) : ('失敗：' + r.error));
}
