// 馬可小幫手：常態 OK 備註清單（Google Apps Script，綁在試算表上）
// 小姐從工具「送審」→ 新增一列「待審核」；主管把狀態改成「核准」才生效。
var SHEET = '常態OK清單';
var HEAD = ['狀態', '客戶', '商品', '備註內容', '適用範圍', '送審人', '送審時間', '審核時間', '說明'];

function sh_() {
  var ss = SpreadsheetApp.getActive();
  var s = ss.getSheetByName(SHEET);
  if (!s) { s = ss.getSheets()[0]; s.setName(SHEET); }
  return s;
}

// 第一次執行：建立表頭、下拉選單、顏色
function setup() {
  var s = sh_();
  s.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold').setBackground('#dfeedd');
  s.setFrozenRows(1);
  s.getRange(2, 1, 1000, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['待審核', '核准', '退回'], true).setAllowInvalid(false).build());
  s.getRange(2, 5, 1000, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['此客戶', '所有客戶'], true).setAllowInvalid(false).build());
  var r = s.getRange(2, 1, 1000, HEAD.length);
  s.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$A2="核准"').setBackground('#d9f2d9').setRanges([r]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$A2="待審核"').setBackground('#fff4cc').setRanges([r]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$A2="退回"').setBackground('#eeeeee').setFontColor('#999999').setRanges([r]).build()
  ]);
  [80, 180, 170, 280, 90, 90, 150, 150, 220].forEach(function (w, i) { s.setColumnWidth(i + 1, w); });
  s.getRange(2, 7, 1000, 2).setNumberFormat('yyyy/mm/dd hh:mm');
}

// 主管改狀態時自動填審核時間
function onEdit(e) {
  var s = e.range.getSheet();
  if (s.getName() !== SHEET || e.range.getColumn() !== 1 || e.range.getRow() < 2) return;
  var v = e.range.getValue();
  s.getRange(e.range.getRow(), 8).setValue((v === '核准' || v === '退回') ? new Date() : '');
}

function rows_() {
  var s = sh_(), n = s.getLastRow();
  if (n < 2) return [];
  return s.getRange(2, 1, n - 1, HEAD.length).getValues().map(function (r) {
    return { status: String(r[0]).trim(), customer: String(r[1]).trim(), product: String(r[2]).trim(),
      note: String(r[3]).trim(), scope: String(r[4]).trim() || '此客戶' };
  }).filter(function (x) { return x.note; });
}

function out_(o, cb) {
  var t = JSON.stringify(o);
  if (cb && /^[\w.]+$/.test(cb)) return ContentService.createTextOutput(cb + '(' + t + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(t).setMimeType(ContentService.MimeType.JSON);
}

// 數量異常學習清單（理貨 Web App 寫入、會計早上核對讀取；待審核／核准＝以後不提醒，退回＝無效）
var LEARN_SHEET = '數量異常學習清單';
function learned_() {
  var s = SpreadsheetApp.getActive().getSheetByName(LEARN_SHEET);
  if (!s || s.getLastRow() < 2) return [];
  return s.getRange(2, 1, s.getLastRow() - 1, 3).getValues().map(function (r) {
    return { status: String(r[0]).trim(), product: String(r[1]).trim(), code: String(r[2]).trim() };
  }).filter(function (x) { return x.product && x.code && (x.status === '核准' || x.status === '待審核'); });
}

// 讀清單：?action=list　送審：?action=submit&customer=&product=&note=&scope=&who=　學習清單：?action=learned
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'submit') return out_(submit_(p), p.callback);
  if (p.action === 'learned') return out_({ ok: true, list: learned_() }, p.callback);
  var list = rows_().filter(function (x) { return x.status === '核准' || x.status === '待審核'; });
  return out_({ ok: true, list: list }, p.callback);
}

function doPost(e) {
  var p = {};
  try { p = JSON.parse(e.postData.contents); } catch (err) { p = (e && e.parameter) || {}; }
  return out_(submit_(p));
}

function norm_(s) {
  return String(s || '').replace(/[\s　]/g, '')
    .replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); })
    .replace(/[×xX*]/g, '*').toLowerCase();
}

// 避免文字被試算表當成公式
function safe_(s) { s = String(s || '').trim(); return /^[=+\-@]/.test(s) ? "'" + s : s; }

function submit_(p) {
  var c = String(p.customer || '').trim(), pr = String(p.product || '').trim(), n = String(p.note || '').trim();
  var sc = p.scope === '所有客戶' ? '所有客戶' : '此客戶', who = String(p.who || '').trim();
  if (!n || !c) return { ok: false, msg: '資料不完整' };
  if (n.length > 300 || c.length > 100 || pr.length > 100 || who.length > 30) return { ok: false, msg: '內容太長' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var dup = rows_().filter(function (x) {
      return (x.status === '核准' || x.status === '待審核') && norm_(x.note) === norm_(n) && norm_(x.product) === norm_(pr) &&
        (x.scope === '所有客戶' || (sc === '此客戶' && norm_(x.customer) === norm_(c)));
    })[0];
    if (dup) return { ok: true, dup: true, status: dup.status };
    sh_().appendRow(['待審核', safe_(c), safe_(pr), safe_(n), sc, safe_(who), new Date(), '', '']);
    return { ok: true };
  } finally { lock.releaseLock(); }
}
