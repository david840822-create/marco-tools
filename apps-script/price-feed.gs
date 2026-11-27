/* ===== 給「馬可小幫手 → 更新批次價格」列出／讀取價格檔 =====
 * 加在 Apps Script 專案「每日報價自動備份」裡（和 archiveDailyQuote 同一個專案，共用
 * ARCHIVE_ROOT_FOLDER_ID、TIME_ZONE 這兩個常數）。
 *
 * 網址（除了 status，都要帶 key=密碼）：
 *   ?action=status[&seen=批次,批次&stop=批次] → {ok, today, now, log:{批次編號:{at, file, warn}}}
 *       （各批次哪時用哪天的價格檔更新過；不用密碼。seen/stop＝小幫手看到的今天批次／已停止批次，給定時寄信提醒用）
 *   ?action=log&batch=批次編號&file=價格檔日期&warn=異常數 → {ok}（更新批次價格成功後記一筆）
 *   ?action=picking&days=3 → {ok, files:[檔名], rows:[[訂單商品ID, 客戶, 品名, 原數量, 單位, 秤重公斤, 轉化公斤數, 是否轉化, 回填數量]]}
 *       （最近幾天理貨表格「匯入馬可系統」分頁，給會計早上核對用）
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
  /* 更新紀錄（只有批次編號和時間，不含價格）：不用密碼，讓每台電腦都能提醒 */
  if (p.action === 'status') { recordSeen_(p.seen, p.stop); return updateStatus_(); }
  var key = PropertiesService.getScriptProperties().getProperty('PRICE_KEY');
  if (!key) return { ok: false, error: '還沒設定密碼（專案設定 → 指令碼屬性 PRICE_KEY）' };
  if (String(p.key || '') !== key) return { ok: false, badKey: true, error: '密碼不對' };
  if (p.action === 'log') return logUpdate_(p);
  if (p.action === 'picking') return pickingRows_(Number(p.days) || 3);
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

/* ===== 批次價格更新紀錄（給「每天提醒有沒有更新價格」用） =====
 * 存在指令碼屬性 PRICE_UPDATE_LOG：{ 批次編號: {at:'yyyy-MM-dd HH:mm', file:'價格檔日期 yyyy-MM-dd', warn:異常數} }
 * 只留最近 10 天。 */
var UPDATE_LOG_PROP = 'PRICE_UPDATE_LOG';
function readUpdateLog_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(UPDATE_LOG_PROP) || '{}'); }
  catch (e) { return {}; }
}
function updateStatus_() {
  return {
    ok: true,
    today: Utilities.formatDate(workDay_(), TIME_ZONE, 'yyyy-MM-dd'),
    now: Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm'),
    log: readUpdateLog_()
  };
}
function logUpdate_(p) {
  var batch = String(p.batch || '').trim(), file = String(p.file || '').trim();
  if (!/^\d{8}$/.test(batch)) return { ok: false, error: '批次編號不對' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(file)) return { ok: false, error: '價格檔日期不對' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var log = readUpdateLog_(), now = new Date();
    log[batch] = { at: Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd HH:mm'), file: file, warn: Number(p.warn) || 0 };
    var cutoff = Utilities.formatDate(new Date(now.getTime() - 10 * 86400000), TIME_ZONE, 'yyyy-MM-dd');
    Object.keys(log).forEach(function (k) { if (!log[k] || String(log[k].at) < cutoff) delete log[k]; });
    PropertiesService.getScriptProperties().setProperty(UPDATE_LOG_PROP, JSON.stringify(log));
  } finally { lock.releaseLock(); }
  return { ok: true };
}

/* ===== 理貨表格的回填資料（給「會計早上核對」比對重量用） =====
 * 找最近 days 天改過的「…理貨表格…」試算表，讀「匯入馬可系統」分頁：
 * 回傳 rows：[訂單商品ID, 客戶簡稱, 商品名稱, 原數量, 單位, 秤重情況(公斤), 轉化公斤數, 是否轉化訂購量, 回填數量]
 * 回填數量空白＝不改（照原數量）。 */
var PICKING_SHEET = '匯入馬可系統';
function pickingRows_(days) {
  days = Math.min(Math.max(days, 1), 10);
  var since = new Date(Date.now() - days * 86400000).toISOString();
  var token = ScriptApp.getOAuthToken(), auth = { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
  /* 理貨表格在共用雲端硬碟，DriveApp 只搜得到自己開過的檔，所以直接用 Drive API 搜全部雲端硬碟 */
  var q = "name contains '理貨表格' and mimeType = 'application/vnd.google-apps.spreadsheet' and modifiedTime > '" + since + "' and trashed = false";
  var files = [], pageToken = '';
  do {
    var lr = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files?corpora=allDrives&includeItemsFromAllDrives=true&supportsAllDrives=true&pageSize=100&fields=nextPageToken,files(id,name)&q=' +
      encodeURIComponent(q) + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), auth);
    if (lr.getResponseCode() !== 200) throw new Error('搜尋理貨表格失敗：' + lr.getContentText().slice(0, 200));
    var lj = JSON.parse(lr.getContentText());
    (lj.files || []).forEach(function (f) { if (!/\{/.test(f.name)) files.push(f); });
    pageToken = lj.nextPageToken || '';
  } while (pageToken && files.length < 200);
  var rows = [], used = [];
  files.forEach(function (f) {
    var url = 'https://docs.google.com/spreadsheets/d/' + f.id + '/gviz/tq?tqx=out:csv&headers=1&sheet=' + encodeURIComponent(PICKING_SHEET);
    var res = UrlFetchApp.fetch(url, auth);
    if (res.getResponseCode() !== 200) return;
    var csv = Utilities.parseCsv(res.getContentText());
    if (!csv.length || String(csv[0][0]).indexOf('訂單商品ID') < 0) return; // 不是理貨表格（沒有這個分頁）
    used.push(f.name);
    for (var i = 1; i < csv.length; i++) {
      var r = csv[i];
      if (!/^\d+$/.test(String(r[0]).trim())) continue;
      rows.push([String(r[0]).trim(), r[2], r[6], r[7], r[8], r[9], r[10], r[11], r[13]]);
    }
  });
  return { ok: true, files: used, rows: rows };
}

/* ===== 今天有哪些批次（小幫手讀出貨批次列表時順便回報，給定時寄信提醒用） =====
 * 存在指令碼屬性 PRICE_SEEN_BATCHES：{ 批次編號: {day:'作業日 yyyy-MM-dd', stop:true?} }
 * 只收批次編號開頭是「作業日」或「作業日隔天」(凌晨建的) 的批次。 */
var SEEN_PROP = 'PRICE_SEEN_BATCHES';
function readSeen_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(SEEN_PROP) || '{}'); }
  catch (e) { return {}; }
}
function recordSeen_(seen, stop) {
  var wd = workDay_(), day = Utilities.formatDate(wd, TIME_ZONE, 'yyyy-MM-dd');
  var okPrefix = [Utilities.formatDate(wd, TIME_ZONE, 'yyMMdd'), Utilities.formatDate(new Date(wd.getTime() + 86400000), TIME_ZONE, 'yyMMdd')];
  function pick(s) {
    return String(s || '').split(',').filter(function (n) { return /^\d{8}$/.test(n) && okPrefix.indexOf(n.slice(0, 6)) >= 0; }).slice(0, 30);
  }
  var act = pick(seen), st = pick(stop);
  if (!act.length && !st.length) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var m = readSeen_(), changed = false;
    act.forEach(function (n) { if (!m[n] || m[n].stop) { m[n] = { day: m[n] ? m[n].day : day }; changed = true; } });
    st.forEach(function (n) { if (!m[n] || !m[n].stop) { m[n] = { day: m[n] ? m[n].day : day, stop: true }; changed = true; } });
    if (!changed) return;
    var cutoff = Utilities.formatDate(new Date(Date.now() - 10 * 86400000), TIME_ZONE, 'yyyy-MM-dd');
    Object.keys(m).forEach(function (k) { if (!m[k] || String(m[k].day) < cutoff) delete m[k]; });
    PropertiesService.getScriptProperties().setProperty(SEEN_PROP, JSON.stringify(m));
  } finally { lock.releaseLock(); }
}

/* ===== 定時寄信提醒：今天的批次還沒更新價格 =====
 * 排程（setupPriceReminder 建立）：每天 19:00 左右、凌晨 00:30 左右（還算前一天）各檢查一次。
 * 有問題才寄信，寄給這個 Apps Script 的擁有者（程式碼裡不放信箱）。 */
function priceReminderText_() {
  var day = Utilities.formatDate(workDay_(), TIME_ZONE, 'yyyy-MM-dd');
  var md = Number(day.slice(5, 7)) + '/' + Number(day.slice(8));
  var log = readUpdateLog_(), seen = readSeen_();
  // 只看每天第一批（有預訂單、要更新價格）：編號最小的那批
  var todays = Object.keys(seen).filter(function (k) { return seen[k].day === day && !seen[k].stop; }).sort().slice(0, 1);
  var done = Object.keys(log).filter(function (k) { return log[k].file === day; }).sort();
  var todo = todays.filter(function (k) { return done.indexOf(k) < 0; });
  var problem = '', lines = [];
  if (todo.length) problem = '今天（' + md + '）第一批 ' + todo[0] + ' 還沒更新價格';
  else if (!done.length) problem = '今天（' + md + '）第一批還沒更新價格';
  if (todo.length) lines.push('還沒更新：' + todo.join('、'));
  lines.push('已更新：' + (done.length ? done.map(function (k) { return k + '（' + String(log[k].at).slice(11) + '）'; }).join('、') : '無'));
  if (!todays.length) lines.push('（今天還沒有人用小幫手打開過出貨批次列表，所以不知道今天建了哪些批次）');
  return { problem: problem, md: md, body: lines.join('\n') };
}
function checkPriceReminder() {
  var r = priceReminderText_();
  if (!r.problem) return;
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '⚠ 馬可：' + r.problem,
    r.problem + '，請行政到後台按「馬可小幫手 → 💲 更新批次價格」。\n\n' + r.body +
    '\n\n後台：https://supply-admin.super-marco.com/delivery-batch/list\n（這封信由 Apps Script「每日報價自動備份」的價格提醒寄出）');
}
/* ===== 常態 OK 清單「待審核」提醒信：寄給主管 =====
 * 收件人放在指令碼屬性 SUPERVISOR_EMAIL（可多個，用逗號隔開；程式碼和 GitHub 都不放信箱）。
 * 排程（setupOkReminder 建立）：每天 10:00、16:00 左右各檢查一次（主管 17:00 上班，16:00 先通知），
 * 「常態 OK 清單」或「數量異常學習清單」有待審核才寄；信裡寫筆數和直接打開該分頁的連結。 */
var OK_SPREADSHEET_ID = '17vD0XABzHYb6wLdZcL94xV4zEflM8MF7v4yyhJ7cc5o';
var OK_SHEET_URL = 'https://docs.google.com/spreadsheets/d/' + OK_SPREADSHEET_ID + '/edit';
/* 直接讀試算表（不經過網路程式）：回傳 [{name, n, url}] */
function okPendingCounts_() {
  var token = ScriptApp.getOAuthToken(), out = [];
  [['常態OK清單', '常態 OK 清單（訂單備註）'], ['數量異常學習清單', '數量異常學習清單（重量／數量異常）']].forEach(function (s) {
    var res = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + OK_SPREADSHEET_ID + '/gviz/tq?tqx=out:csv&headers=1&sheet=' + encodeURIComponent(s[0]),
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return;
    var csv = Utilities.parseCsv(res.getContentText());
    if (!csv.length || String(csv[0][0]).indexOf('狀態') < 0) return; // 分頁不存在時 gviz 會回第一個分頁
    var n = csv.slice(1).filter(function (r) { return String(r[0]).trim() === '待審核'; }).length;
    out.push({ name: s[1], n: n });
  });
  return out;
}
/* 「異常紀錄」裡會計按「有錯，要更改」的（處理結果以「確認有錯」開頭）、N 欄「追蹤結果」還沒寫的 → 待追蹤筆數（2026-11-27 使用者要求：有錯要有人追） */
function okTrackCount_() {
  var res = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + OK_SPREADSHEET_ID + '/gviz/tq?tqx=out:csv&headers=1&sheet=' + encodeURIComponent('異常紀錄'),
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return 0;
  var csv = Utilities.parseCsv(res.getContentText());
  if (!csv.length || String(csv[0][12] || '').indexOf('處理結果') < 0) return 0;
  return csv.slice(1).filter(function (r) { return /^確認有錯/.test(String(r[12] || '').trim()) && !String(r[13] || '').trim(); }).length;
}
function okPendingReminder() {
  var to = PropertiesService.getScriptProperties().getProperty('SUPERVISOR_EMAIL');
  if (!to) return;
  var list = okPendingCounts_().filter(function (x) { return x.n > 0; });
  var track = 0; try { track = okTrackCount_(); } catch (e) {}
  if (!list.length && !track) return;
  var total = list.reduce(function (s, x) { return s + x.n; }, 0);
  var subj = '📝 馬可：' + [total ? '有 ' + total + ' 筆待主管審核' : '', track ? track + ' 筆「有錯」待追蹤' : ''].filter(String).join('、');
  MailApp.sendEmail(to, subj,
    list.map(function (x) { return '・' + x.name + '：' + x.n + ' 筆待審核'; }).join('\n') +
    (track ? (list.length ? '\n' : '') + '・異常紀錄（會計早上核對按「有錯，要更改」）：' + track + ' 筆待追蹤' : '') +
    '\n\n點這裡直接打開試算表：\n' + OK_SHEET_URL +
    (list.length ? '\n・待審核：在 A 欄把「待審核」改成「核准」或「退回」（下方分頁可切換「常態OK清單」和「數量異常學習清單」）' : '') +
    (track ? '\n・有錯待追蹤：到「異常紀錄」分頁，M 欄是「確認有錯」的，在 N 欄「追蹤結果」寫原因或處理方式（例如：理貨秤錯、已提醒），寫了就不再提醒' : '') +
    '\n\n（這封信由 Apps Script「每日報價自動備份」寄出，每天 10:00、16:00 檢查，有待處理才寄）');
}
/* 在編輯器手動執行一次：建立待審核提醒排程（不寄信，只在記錄裡顯示目前幾筆） */
function setupOkReminder() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'okPendingReminder') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('okPendingReminder').timeBased().everyDays(1).atHour(10).nearMinute(0).inTimezone(TIME_ZONE).create();
  ScriptApp.newTrigger('okPendingReminder').timeBased().everyDays(1).atHour(16).nearMinute(0).inTimezone(TIME_ZONE).create();
  var to = PropertiesService.getScriptProperties().getProperty('SUPERVISOR_EMAIL') || '';
  console.log('已建立待審核提醒排程（10:00、16:00）；收件人 ' + (to ? to.split(',').length + ' 位' : '還沒設定') + '；目前 ' +
    okPendingCounts_().map(function (x) { return x.name + ' ' + x.n + ' 筆'; }).join('、'));
}

/* 在編輯器手動執行一次：建立排程，並寄一封測試信 */
function setupPriceReminder() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkPriceReminder') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkPriceReminder').timeBased().everyDays(1).atHour(19).nearMinute(0).inTimezone(TIME_ZONE).create();
  ScriptApp.newTrigger('checkPriceReminder').timeBased().everyDays(1).atHour(0).nearMinute(30).inTimezone(TIME_ZONE).create();
  var r = priceReminderText_();
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '✅ 馬可：價格更新提醒已設定（測試信）',
    '之後每天 19:00 左右、凌晨 00:30 左右檢查一次，今天的批次有沒更新價格的才會寄信。\n\n目前狀態（' + r.md + '）：' + (r.problem || '沒有問題') + '\n' + r.body);
  console.log('已建立排程並寄出測試信');
}

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
  console.log('更新紀錄：' + JSON.stringify(readUpdateLog_()));
  var pk = pickingRows_(2);
  console.log('理貨表格：' + pk.files.join('、') + '；共 ' + pk.rows.length + ' 列；第一列 ' + JSON.stringify(pk.rows[0]));
}
