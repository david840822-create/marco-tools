/* 馬可小幫手：會計早上核對（GitHub 上的 morning.js）— 第一階段：只看不改
 * 今天到貨的訂單：
 *   1. 重量／數量可疑：跟理貨表格「匯入馬可系統」回填值比對（打錯）、秤重品沒秤、台斤公斤搞混、差很多
 *   2. 實價／外購品（價格 0）：列出來，等會計對照採購單補重量、價格
 *   3. 運費：同客戶當天訂單合併，達門檻（後台「運費群組」）全部 0；沒達到只收一次
 *   4. 沒問題的訂單（之後加「一鍵已送達」）
 * 資料來源：自有訂單列表（訂單、金額、狀態）、批次「匯出訂單金額數量」（品項、目前數量、價格）、
 *           價格網路程式 ?action=picking（理貨表格回填值）、店鋪配置／運費群組（免運門檻）。
 * 批次匯出／解壓功能共用 price.js（用它的 __MK_PRICE_TEST 介面取出函式）。
 */
(async function () {
  var PRICE_API = 'https://script.google.com/macros/s/AKfycbwkph6A7dMEcndMv1WhczRhX0O0EIbZ3XPCgC4DUuAjybAHYP9zRkVJ9c_BN6jWUexW/exec';
  var KEY_STORE = 'mk-price-key';
  var ORIGIN = location.origin;
  var STATUS_RE = /^(待審核|已接單|揀貨完成|配送中|已送達|已取消)$/;
  if (!/super-marco\.com$/.test(location.hostname)) { alert('請在馬可供應商後台的頁面上使用。'); return; }
  var cs = document.currentScript && document.currentScript.src;
  var BASE = window.__MK_BASE || (cs ? cs.replace(/[^\/]*(\?.*)?$/, '') : 'https://david840822-create.github.io/marco-tools/');
  var old = document.getElementById('mk-mc'); if (old) old.remove();

  /* ---------- 小工具 ---------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function txt(el) { return (el && el.innerText || '').replace(/\s+/g, ' ').trim(); }
  function lines(s) { return String(s || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function num(v) { var n = Number(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : NaN; }
  function fmt(n) { return isFinite(n) ? String(Math.round(n * 100) / 100) : '?'; }
  function money(n) { return isFinite(n) ? 'NT$ ' + (Math.round(n * 10) / 10).toLocaleString() : '?'; }
  function getKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
  async function waitFor(fn, timeout, step) {
    var t0 = Date.now();
    while (Date.now() - t0 < (timeout || 15000)) {
      var r = null; try { r = fn(); } catch (e) { r = null; }
      if (r) return r;
      await sleep(step || 250);
    }
    return null;
  }
  function openFrame(url) {
    var f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:-12000px;top:0;width:1400px;height:1000px;visibility:hidden;';
    f.src = url;
    document.body.appendChild(f);
    return f;
  }
  function fiberKey(el) {
    var k = Object.keys(el).find(function (k) { return k.indexOf('__reactFiber') === 0; });
    var f = k && el[k];
    for (var i = 0; i < 8 && f; i++) { if (f.key != null) return String(f.key); f = f.return; }
    return null;
  }
  function btn(doc, t) { return [].find.call(doc.querySelectorAll('button'), function (b) { return b.innerText.replace(/\s+/g, '') === t; }); }
  async function pool(items, n, fn) {
    var i = 0, out = new Array(items.length);
    async function worker() { while (i < items.length) { var k = i++; out[k] = await fn(items[k], k); } }
    var ws = []; for (var j = 0; j < Math.min(n, items.length); j++) ws.push(worker());
    await Promise.all(ws);
    return out;
  }

  /* ---------- 畫面 ---------- */
  var box = document.createElement('div');
  box.id = 'mk-mc';
  box.style.cssText = 'position:fixed;inset:3vh 3vw;z-index:2147483647;background:#fff;border:2px solid #2e7d4f;border-radius:10px;box-shadow:0 8px 40px rgba(0,0,0,.3);font:14px/1.5 "Microsoft JhengHei",sans-serif;color:#222;display:flex;flex-direction:column;';
  box.innerHTML = '<div style="display:flex;align-items:center;gap:12px;background:#2e7d4f;color:#fff;padding:8px 14px;border-radius:8px 8px 0 0">' +
    '<b style="font-size:17px">☀️ 會計早上核對</b><span id="mk-mc-date" style="font-size:14px"></span><span style="flex:1"></span>' +
    '<span style="font-size:12px;opacity:.85">只會檢查；只有勾選後按「改成已送達」才會改狀態</span>' +
    '<button id="mk-mc-x" style="background:none;border:0;color:#fff;font-size:20px;cursor:pointer">✕</button></div>' +
    '<div id="mk-mc-status" style="padding:8px 14px;color:#555;white-space:pre-line;border-bottom:1px solid #eee"></div>' +
    '<div id="mk-mc-body" style="flex:1;overflow:auto;padding:6px 14px 14px"></div>';
  document.body.appendChild(box);
  var $ = function (id) { return document.getElementById(id); };
  $('mk-mc-x').onclick = function () { box.remove(); };
  function status(s) { $('mk-mc-status').textContent = s; }

  var DATE = ymd(new Date());
  $('mk-mc-date').textContent = '到貨日 ' + DATE;

  /* ---------- 1. 自有訂單列表：今天到貨的訂單 ---------- */
  /* 後台把篩選條件存在 localStorage「defaultOrderFilterData」，打開列表時照它篩選。
   * 先暫時寫入「全部＋期望配送日期＝到貨日」，讀完再還原成原本的設定。 */
  var LS_FILTER = 'defaultOrderFilterData';
  async function readOrderList(date) {
    var prevLs = null; try { prevLs = localStorage.getItem(LS_FILTER); } catch (e) {}
    var dd = date.replace(/-/g, '/');
    localStorage.setItem(LS_FILTER, JSON.stringify({ condition: { page: 1, size: 100, keywords: '', buyerIds: [], districtIds: [], deliverDate: { from: dd, to: dd }, orderDate: {}, deliverTime: [], billedStatus: [] }, status: 'total', orderBy: 'orderDate', selectedIds: [] }));
    var f = openFrame('/order/own'), doc;
    function tabEl(re) { return [].find.call(doc.querySelectorAll('button,[role=tab]'), function (b) { return re.test(b.innerText.replace(/\s+/g, '')); }); }
    try {
      var tab = await waitFor(function () { doc = f.contentDocument; return tabEl(/^全部\(\d+\)$/); }, 30000);
      if (!tab) throw new Error('打不開「自有訂單」頁面');
      var total = -1, lastT = -2, sameT = 0;
      await waitFor(function () {
        var t = tabEl(/^全部\(\d+\)$/); if (!t) return false;
        var n = parseInt(t.innerText.replace(/\D/g, ''), 10);
        var dates = [].map.call(doc.querySelectorAll('table tbody tr'), function (tr) { return (/(\d{4}-\d{2}-\d{2})/.exec(tr.innerText) || [])[1]; }).filter(Boolean);
        var okDates = dates.length && dates.every(function (x) { return x === date; });
        // 一開始會先顯示「全部(0)」約 10 秒，要等到有數字、而且列出來的都是到貨日的單
        if (n > 0 && n === lastT && okDates) sameT++; else sameT = 0;
        lastT = n; total = n;
        return sameT >= 4;
      }, 45000, 250);
      if (!(total > 0)) return [];
      if (total > 1000) throw new Error('篩選到貨日沒成功（列出 ' + total + ' 張），請重新整理後台頁面再試一次');
      var psLab = [].find.call(doc.querySelectorAll('p'), function (e) { return /每頁顯示筆數/.test(e.textContent); });
      var ps = psLab && psLab.parentElement.querySelector('[role=button]');
      if (ps && ps.innerText.trim() !== '100') {
        ps.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); ps.click(); ps.click();
        var opt = await waitFor(function () { return [].find.call(doc.querySelectorAll('li,[role=option]'), function (o) { return o.textContent.trim() === '100'; }); }, 4000);
        if (opt) { opt.click(); await waitFor(function () { return doc.querySelectorAll('table tbody tr').length >= Math.min(total, 100); }, 8000, 250); }
      }
      var out = {}, page = 1;
      while (true) {
        status('讀取訂單列表…（' + Object.keys(out).length + '/' + total + '）');
        var last = '', same = 0;
        await waitFor(function () {
          var rows = [].slice.call(doc.querySelectorAll('table tbody tr')).filter(function (tr) { return /NT\$/.test(tr.innerText); });
          var sig = rows.map(fiberKey).join(',');
          if (rows.length && sig === last) same++; else same = 0;
          last = sig;
          return same >= 2;
        }, 15000, 250);
        [].forEach.call(doc.querySelectorAll('table tbody tr'), function (tr) {
          var id = (fiberKey(tr) || '').replace(/\D/g, '');
          if (!id || !/NT\$/.test(tr.innerText)) return;
          var cell = [].find.call(tr.querySelectorAll('td'), function (td) { return /\d{8,}/.test(td.innerText); });
          var c = lines(cell && cell.innerText);
          var dm = /(\d{4}-\d{2}-\d{2})/.exec(tr.innerText);
          var am = /NT\$\s*([\d,]+(?:\.\d+)?)/.exec(tr.innerText);
          var st = lines(tr.innerText).find(function (s) { return STATUS_RE.test(s); }) || '';
          out[id] = { id: id, customer: c[0] || '', no: c[2] || '', date: dm ? dm[1] : '', amount: am ? num(am[1]) : NaN, status: st, pickup: /自取/.test(tr.innerText) };
        });
        if (Object.keys(out).length >= total) break;
        var next = [].find.call(doc.querySelectorAll('button'), function (b) { return /下一頁|next page/i.test(b.getAttribute('aria-label') || '') && !b.disabled; });
        if (!next || page > 40) break;
        next.click(); page++;
        await sleep(500);
      }
      return Object.keys(out).map(function (k) { return out[k]; }).filter(function (o) { return o.date === date; });
    } finally {
      f.remove();
      try { if (prevLs == null) localStorage.removeItem(LS_FILTER); else localStorage.setItem(LS_FILTER, prevLs); } catch (e) {}
    }
  }

  /* ---------- 2. 批次匯出：品項、目前數量、價格（共用 price.js 的函式） ---------- */
  async function priceTools() {
    var src = await (await fetch(BASE + 'price.js?t=' + Date.now())).text();
    var T = null;
    window.__MK_PRICE_TEST = function (t) { T = t; };
    try { (0, eval)(src); } finally { delete window.__MK_PRICE_TEST; }
    await waitFor(function () { return T; }, 5000, 50);
    if (!T) throw new Error('載入 price.js 失敗');
    return T;
  }
  async function readBatchItems(T, date, orderIds) {
    var g = null;
    var list = T.readBatchList(document);
    if (!list.length) {
      var f = openFrame('/delivery-batch/list');
      var lastN = -1, sameN = 0;
      await waitFor(function () { var n = T.readBatchList(f.contentDocument).length; if (n && n === lastN) sameN++; else sameN = 0; lastN = n; return sameN >= 3; }, 30000, 300);
      list = T.readBatchList(f.contentDocument); f.remove();
    }
    // 到貨日前 2 天～到貨日中午建立的批次
    var d0 = new Date(date + 'T00:00:00'), from = new Date(d0.getTime() - 2 * 86400000), to = new Date(d0.getTime() + 12 * 3600000);
    var cand = list.filter(function (b) {
      if (/已停止|已中斷/.test(b.status)) return false;
      var t = new Date(b.date.replace(/\//g, '-') + 'T' + (b.time || '00:00') + ':00');
      return t >= from && t <= to;
    });
    var want = {}; orderIds.forEach(function (id) { want[id] = 1; });
    var items = {}, batchOf = {}, found = {};
    for (var i = 0; i < cand.length; i++) {
      if (Object.keys(want).every(function (id) { return found[id]; })) break;
      var b = cand[i];
      status('匯出批次 ' + b.no + '（' + (i + 1) + '/' + cand.length + '）讀品項…');
      try {
        var o = T.readOrders(T.openBook(await T.unzip(await T.exportBatch(b))));
        o.rows.forEach(function (r) {
          var oid = String(r.A || '').trim(); if (!oid || !want[oid]) return;
          found[oid] = 1; batchOf[oid] = b.no;
          (items[oid] = items[oid] || []).push({ itemId: String(r.B), name: r.H || '', unit: String(r.I || ''), excl: String(r.J || ''), note: r.K || '', qty: num(r.L), price: num(r.M) });
        });
      } catch (e) { console.warn('批次 ' + b.no + ' 匯出失敗', e); }
    }
    return { items: items, batchOf: batchOf };
  }

  /* ---------- 3. 理貨表格回填值 ---------- */
  async function readPicking() {
    var key = getKey();
    if (!key) return { error: '這台電腦還沒輸入「價格密碼」（先按一次「更新批次價格」輸入），所以沒辦法比對理貨表格' };
    try {
      var r = await (await fetch(PRICE_API + '?key=' + encodeURIComponent(key) + '&action=picking&days=3', { redirect: 'follow' })).json();
      if (!r.ok) return { error: r.badKey ? '價格密碼不對' : (r.error || '讀不到理貨表格') };
      var map = {};
      r.rows.forEach(function (x) { map[x[0]] = { customer: x[1], name: x[2], qty: num(x[3]), unit: x[4], kg: x[5] === '' ? NaN : num(x[5]), conv: num(x[6]), isConv: String(x[7]) === '1', back: String(x[8] == null ? '' : x[8]).trim() }; });
      return { map: map, files: r.files };
    } catch (e) { return { error: '讀不到理貨表格：' + e.message }; }
  }

  /* ---------- 4. 運費群組：客戶 → 免運門檻 ---------- */
  function thrOf(t) {
    if (/固定運費\s*\$\s*0(?!\d)/.test(t)) return 0;
    var m = /\$([\d,]+(?:\.\d+)?)\s*以上/.exec(t);
    return m ? num(m[1]) : NaN;
  }
  function feeOf(t) { var m = /運費\s*\$\s*([\d,]+)\s*\$\s*0\s*~/.exec(t); return m ? num(m[1]) : 100; }
  async function readFreight() {
    var f = openFrame('/setting/freightGroup/list'), rows = [];
    var last = '', same = 0;
    await waitFor(function () {
      rows = [].map.call(f.contentDocument.querySelectorAll('tbody tr'), function (tr) { return { id: (fiberKey(tr) || '').replace(/\D/g, ''), t: txt(tr) }; });
      var sig = rows.map(function (r) { return r.t; }).join('|');
      if (rows.length && sig === last) same++; else same = 0;
      last = sig; return same >= 3;
    }, 30000, 300);
    f.remove();
    var res = { def: 800, fee: 100, byCustomer: {}, groups: [] };
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], thr = thrOf(r.t);
      if (/默認套用/.test(r.t)) { if (isFinite(thr)) res.def = thr; res.fee = feeOf(r.t); continue; }
      if (!/指定客戶/.test(r.t) || !r.id) { res.groups.push({ name: r.t.slice(0, 20), skipped: true }); continue; }
      var cnt = +((/指定客戶\s*(\d+)\s*個/.exec(r.t) || [])[1] || 0);
      status('讀運費群組：' + r.t.split(' ')[0] + '（' + cnt + ' 家）');
      // 編輯頁「套用客戶(N)」下面是「客戶名稱／客戶編號(或 -)」兩行一組；只讀不按儲存
      var e = openFrame('/setting/freightGroup/edit/' + r.id), names = null, lastSig = '', sameN = 0;
      names = await waitFor(function () {
        var t = e.contentDocument.body.innerText;
        var m = /套用客戶\((\d+)\)/.exec(t); if (!m || !+m[1]) return null;
        var a = t.indexOf('編輯/新增', m.index), b = t.indexOf('\n刪除', a);
        if (a < 0 || b < 0) return null;
        var ls = lines(t.slice(a + 5, b)), ns = [];
        for (var k = 0; k < ls.length; k += 2) ns.push(ls[k]);
        var sig = ns.join('|');
        if (ns.length === +m[1] && sig === lastSig) sameN++; else sameN = 0;
        lastSig = sig;
        return sameN >= 2 ? ns : null;
      }, 30000, 300);
      e.remove();
      (names || []).forEach(function (n) { res.byCustomer[n] = thr; });
      res.groups.push({ name: r.t.split(' ')[0], thr: thr, n: (names || []).length, cnt: cnt });
    }
    return res;
  }

  /* 訂單詳情的「價格明細」：運費金額、商家優惠、實際應付 */
  async function readPriceInfo(id) {
    var f = openFrame('/order/detail/' + id);
    try {
      var t = await waitFor(function () { var x = f.contentDocument.body.innerText; return /實際應付\s*NT\$/.test(x) ? x : null; }, 30000, 300);
      if (!t) return null;
      function amt(label) { var m = new RegExp(label + '\\s*\\n*\\s*-?\\s*NT\\$\\s*([\\d,.]+)').exec(t); return m ? num(m[1]) : 0; }
      return { fee: amt('運費金額'), discount: amt('商家優惠'), pay: amt('實際應付') };
    } finally { f.remove(); }
  }

  /* ---------- 一鍵已送達：訂單詳情頁「開始配送」→「已送達」（後台不能跳過配送中） ----------
   * 只按文字完全相符的按鈕；「取消訂單」永遠不碰。跳出確認視窗時，只有視窗裡沒有「取消訂單」字樣才按確定。 */
  function detailStatus(doc) {
    var t = doc.body.innerText, i = t.lastIndexOf('訂單詳情');
    if (i < 0 || t.indexOf('配送方式', i) < 0) return '';
    return lines(t.slice(i, t.indexOf('配送方式', i))).find(function (s) { return STATUS_RE.test(s); }) || '';
  }
  var NEXT_BTN = { '已接單': /^開始配送$/, '揀貨完成': /^開始配送$/, '配送中': /^(已送達|完成配送|確認送達|送達完成)$/ };
  async function deliverOne(o) {
    var f = openFrame('/order/detail/' + o.id);
    try {
      for (var step = 0; step < 3; step++) {
        var st = await waitFor(function () { return detailStatus(f.contentDocument); }, 30000, 300);
        if (!st) return { ok: false, msg: '讀不到訂單狀態' };
        if (st === '已送達') return { ok: true, msg: '✓ 已送達' };
        var re = NEXT_BTN[st];
        if (!re) return { ok: false, msg: '狀態是「' + st + '」，不處理' };
        var d = f.contentDocument;
        var b = [].find.call(d.querySelectorAll('button'), function (x) { return re.test(x.innerText.replace(/\s+/g, '')) && !x.disabled; });
        if (!b) return { ok: false, msg: '找不到「' + (st === '配送中' ? '已送達' : '開始配送') + '」按鈕' };
        b.click();
        // 有確認視窗就按確定（視窗裡不能有「取消訂單」）
        var dlgBtn = await waitFor(function () {
          var dlg = [].find.call(d.querySelectorAll('[role=dialog]'), function (x) { return x.innerText.trim(); });
          if (!dlg || /取消訂單|取消此訂單/.test(dlg.innerText)) return null;
          return [].find.call(dlg.querySelectorAll('button'), function (x) { return /^(確定|確認|是|送出|確定送達)$/.test(x.innerText.replace(/\s+/g, '')); });
        }, 2500, 200);
        if (dlgBtn) dlgBtn.click();
        var changed = await waitFor(function () { var s2 = detailStatus(f.contentDocument); return s2 && s2 !== st ? s2 : null; }, 15000, 300);
        if (!changed) { f.contentWindow.location.reload(); await sleep(1500); }
      }
      return { ok: false, msg: '改了三次還不是已送達，請手動確認' };
    } catch (e) { return { ok: false, msg: '錯誤：' + e.message }; }
    finally { f.remove(); }
  }
  async function deliverPicked() {
    var ids = [].map.call(document.querySelectorAll('.mk-mc-dv:checked'), function (c) { return c.value; });
    var todo = R.orders.filter(function (o) { return ids.indexOf(o.id) >= 0; });
    if (!todo.length) return;
    $('mk-mc-dvgo').disabled = true;
    var done = 0, fail = [];
    await pool(todo, 2, async function (o) {
      var el = document.querySelector('.mk-mc-dvst[data-id="' + o.id + '"]');
      if (el) el.textContent = '處理中…';
      var r = await deliverOne(o);
      o.status = r.ok ? '已送達' : o.status;
      if (el) { el.textContent = r.msg; el.style.color = r.ok ? '#1b5e20' : '#b71c1c'; }
      if (r.ok) done++; else fail.push(o.customer + ' ' + o.no + '：' + r.msg);
      status('改成已送達：' + done + '/' + todo.length + (fail.length ? '，失敗 ' + fail.length : ''));
    });
    $('mk-mc-dvmsg').innerHTML = '<b style="color:#1b5e20">完成 ' + done + ' 張</b>' + (fail.length ? '<div style="color:#b71c1c">' + fail.map(esc).join('<br>') + '</div>' : '');
  }

  /* ---------- 5. 檢查規則 ---------- */
  var FREE_NOTE = /補送|贈送|招待|免費|不收|取消|缺貨|下錯/;
  function baseUnit(u) { return String(u || '').split('|')[0].replace(/[（(].*$/, '').trim(); }
  var WEIGHT_U = /^(台斤|斤|公斤|兩|K|KG|kg|公克|克|g)$/;
  /* 異常代碼和判斷門檻跟「理貨作業 Web App」的 checkRow 同一套（兩邊改規則要一起改）：
   *   zero、same-as-qty、same-as-estimate、unit-06、too-much、far、each-weird、count-over
   * 早上多一條 backfill-diff：後台數字跟理貨表格回填值不一樣（輸入時打錯，只有早上查得到）。
   * 「數量異常學習清單」（常態 OK 清單試算表的分頁）裡「商品＋代碼」待審核／核准的，兩邊都不再提醒。 */
  function checkItem(it, pk) {
    var flags = [], u = baseUnit(it.unit), byPiece = /秤重/.test(it.unit), isW = WEIGHT_U.test(u);
    var orig = pk ? pk.qty : NaN, cur = it.qty;
    var kg = pk && isFinite(pk.kg) ? pk.kg : NaN;                                   // 理貨實秤公斤
    var expectedKg = pk && isFinite(orig) && isFinite(pk.conv) && pk.conv > 0 ? orig * pk.conv : NaN; // 預估公斤
    if (!isFinite(cur)) { flags.push({ code: 'unreadable', lv: 2, t: '數量讀不到' }); return flags; }
    // 只有秤重的品項才比對回填值（按顆、按包的品項，理貨表格的回填是公斤換算，不適用）
    if ((isW || byPiece) && pk && pk.back !== '' && isFinite(num(pk.back)) && Math.abs(cur - num(pk.back)) > 0.011)
      flags.push({ code: 'backfill-diff', lv: 2, t: '系統是 ' + fmt(cur) + '，理貨表格回填 ' + pk.back + '（可能打錯）' });
    if (cur === 0) { if (!FREE_NOTE.test(it.note)) flags.push({ code: 'zero', lv: 1, t: '數量 0（缺貨？請確認）' }); return flags; }
    if (byPiece && isFinite(orig) && Math.abs(cur - orig) < 0.001 && (!pk || pk.back === ''))
      flags.push({ code: 'same-as-qty', lv: 2, t: '秤重計價，但數量還是 ' + fmt(cur) + '（跟訂購一樣，可能沒秤重）' });
    if (byPiece && isFinite(kg) && isFinite(expectedKg) && expectedKg > 0 && Math.abs(kg - expectedKg) < 0.001)
      flags.push({ code: 'same-as-estimate', lv: 2, t: '實秤 ' + fmt(kg) + ' 公斤剛好等於預估（秤重計價卻像沒秤，照抄預估）' });
    if (isFinite(orig) && orig > 0) {
      var ratio = cur / orig;
      if (isW || byPiece) {
        if (isW && ((ratio >= 0.55 && ratio <= 0.65) || (ratio >= 1.55 && ratio <= 1.75)))
          flags.push({ code: 'unit-06', lv: 2, t: '原訂 ' + fmt(orig) + ' → ' + fmt(cur) + '（剛好差 0.6 倍，可能台斤／公斤搞混）' });
        else if (ratio > 5)
          flags.push({ code: 'too-much', lv: 2, t: '原訂 ' + fmt(orig) + ' → ' + fmt(cur) + '（太誇張）' });
        else if (isW && (ratio > 1.5 || ratio < 0.6))
          flags.push({ code: 'far', lv: 1, t: '原訂 ' + fmt(orig) + ' → ' + fmt(cur) + '（差很多，請確認）' });
        if (byPiece) { // 一個多重：有實秤公斤就用實秤，沒有就用台斤換算
          var each = (isFinite(kg) ? kg : cur * 0.6) / orig;
          if (each > 15 || each < 0.05) flags.push({ code: 'each-weird', lv: 2, t: '一個約 ' + fmt(each) + ' 公斤（不合理，可能打錯）' });
        }
      } else if (ratio > 3) {
        flags.push({ code: 'count-over', lv: 2, t: '原訂 ' + fmt(orig) + ' → ' + fmt(cur) + '（多很多，可能打錯）' });
      }
    }
    return flags;
  }
  /* 數量異常學習清單：{ '商品|代碼': 狀態 }（讀常態 OK 清單網路程式 ?action=learned；讀不到就當作空的，照樣提醒） */
  var OK_API = 'https://script.google.com/macros/s/AKfycbxQK0BUWNmiNjh5sbU77y8X0YnerMfF7eakGQMjZJQxwsZBcw0Lh0QTDHjBognWIikpew/exec';
  async function readLearned() {
    try {
      var j = await (await fetch(OK_API + '?action=learned&t=' + Date.now())).json();
      var map = {};
      ((j && j.list) || []).forEach(function (x) { if (x.code && x.product) map[String(x.product).trim() + '|' + x.code] = x.status || true; });
      return map;
    } catch (e) { return {}; }
  }

  /* 異常紀錄：每次核對完，把抓到的重量／數量異常送到常態 OK 清單試算表的「異常紀錄」分頁，累積起來做分析。
   * 同一天＋同訂單＋同商品＋同代碼只記一次（網路程式那邊去重），所以重跑核對不會重複記。 */
  function logAnomalies(orders) {
    var rows = [];
    orders.forEach(function (o) {
      (o.items || []).forEach(function (it) {
        (it.flags || []).forEach(function (f) {
          if (!f.code) return;
          rows.push({ date: DATE, customer: o.customer, orderNo: o.no, product: it.name, unit: it.unit, code: f.code, text: f.t,
            orig: it.pk && isFinite(it.pk.qty) ? it.pk.qty : '', cur: isFinite(it.qty) ? it.qty : '',
            kg: it.pk && isFinite(it.pk.kg) ? it.pk.kg : '', source: '早上核對' });
        });
      });
    });
    if (!rows.length) return;
    fetch(OK_API, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'log', rows: rows }) })
      .then(function () { var el = $('mk-mc-status'); if (el) el.textContent += '　（' + rows.length + ' 筆異常已記錄到「異常紀錄」）'; })
      .catch(function () { var el = $('mk-mc-status'); if (el) el.textContent += '　（異常紀錄沒送出）'; });
  }

  /* ---------- 主流程 ---------- */
  var R = null;
  async function run() {
    var T0 = Date.now();
    try {
      status('讀取今天到貨的訂單…');
      var orders = (await readOrderList(DATE)).filter(function (o) { return o.status !== '已取消'; });
      if (!orders.length) { status('今天（' + DATE + '）沒有到貨的訂單。'); return; }
      var T = await priceTools();
      var pkP = readPicking(), frP = readFreight(), lnP = readLearned();
      var bi = await readBatchItems(T, DATE, orders.map(function (o) { return o.id; }));
      status('讀理貨表格、運費群組…');
      var pk = await pkP, fr = await frP, learned = await lnP, skippedByLearn = 0;
      var pmap = pk.map || {};
      orders.forEach(function (o) {
        o.items = bi.items[o.id] || null;
        o.batch = bi.batchOf[o.id] || '';
        o.flags = []; o.zero = [];
        if (!o.items) { o.flags.push({ lv: 2, t: '找不到這張單的品項（沒有建出貨批次？）' }); return; }
        o.goods = 0;
        o.items.forEach(function (it) {
          var p = pmap[it.itemId];
          it.pk = p || null;
          it.flags = checkItem(it, p).filter(function (f) {
            if (f.code && learned[String(it.name).trim() + '|' + f.code]) { skippedByLearn++; return false; }
            return true;
          });
          if (it.flags.length) o.flags.push({ item: it });
          // 價格 0：數量 0、或備註寫了補送／取消／缺貨等（本來就不收錢）不算，其他才是要補價的實價／外購品
          if (!(it.price > 0)) { if (it.qty > 0 && !FREE_NOTE.test(it.note)) o.zero.push(it); else o.freeN = (o.freeN || 0) + 1; }
          if (isFinite(it.qty) && isFinite(it.price)) o.goods += it.qty * it.price;
        });
        o.goods = Math.round(o.goods * 10) / 10;
        var fee = o.amount - o.goods;
        o.fee = Math.abs(fee) < 1 ? 0 : (Math.abs(fee - fr.fee) < 1 ? fr.fee : Math.round(fee * 10) / 10);
      });
      // 運費：同客戶合併
      var byC = {};
      orders.forEach(function (o) { (byC[o.customer] = byC[o.customer] || []).push(o); });
      var freight = Object.keys(byC).map(function (c) {
        var os = byC[c], sum = os.reduce(function (s, o) { return s + (o.goods || 0); }, 0);
        var thr = c in fr.byCustomer ? fr.byCustomer[c] : fr.def;
        var cur = os.reduce(function (s, o) { return s + (isFinite(o.fee) ? o.fee : 0); }, 0);
        var pickup = os.every(function (o) { return o.pickup; }); // 自取不收運費
        var want = pickup || thr === 0 || sum >= thr ? 0 : fr.fee;
        var pending = os.some(function (o) { return o.zero.length; });
        return { customer: c, orders: os, sum: sum, thr: thr, cur: cur, want: want, pending: pending, pickup: pickup, inGroup: c in fr.byCustomer };
      });
      // 要調整運費的客戶：打開訂單詳情看「運費金額／商家優惠」（列表金額看不出優惠抵掉的運費）
      var fix = freight.filter(function (f) { return Math.abs(f.cur - f.want) > 0.5; });
      var fixOrders = []; fix.forEach(function (f) { fixOrders = fixOrders.concat(f.orders); });
      if (fixOrders.length) {
        status('讀取 ' + fixOrders.length + ' 張要調運費的訂單明細…');
        await pool(fixOrders, 3, async function (o) { o.priceInfo = await readPriceInfo(o.id); });
      }
      R = { orders: orders, freight: freight, pk: pk, fr: fr, skippedByLearn: skippedByLearn, learnedN: Object.keys(learned).length, secs: Math.round((Date.now() - T0) / 1000) };
      window.__MK_MC_R = R; // 給維護者除錯用
      render();
      logAnomalies(orders);
    } catch (e) {
      status('發生錯誤：' + e.message);
      console.error(e);
    }
  }

  /* ---------- 顯示 ---------- */
  function section(title, color, inner, count) {
    return '<div style="margin-top:12px;border:1px solid ' + color + ';border-radius:8px;overflow:hidden">' +
      '<div style="background:' + color + ';color:#fff;padding:6px 10px;font-weight:700">' + title + (count != null ? '（' + count + '）' : '') + '</div>' +
      '<div style="padding:8px 10px">' + inner + '</div></div>';
  }
  function oLink(o) { return '<a href="/order/detail/' + esc(o.id) + '" target="_blank" style="color:#1565c0">' + esc(o.no) + '</a>'; }
  function render() {
    var os = R.orders;
    var flagged = os.filter(function (o) { return o.flags.length; });
    var zeroO = os.filter(function (o) { return o.zero.length; });
    var frFix = R.freight.filter(function (f) { return Math.abs(f.cur - f.want) > 0.5; });
    var okO = os.filter(function (o) { return !o.flags.length && !o.zero.length; });
    var cnt = {}; os.forEach(function (o) { cnt[o.status] = (cnt[o.status] || 0) + 1; });
    status('今天到貨 ' + os.length + ' 張（' + Object.keys(cnt).map(function (k) { return k + ' ' + cnt[k]; }).join('、') + '），用時 ' + R.secs + ' 秒。' +
      (R.pk.error ? '\n⚠ ' + R.pk.error : '　理貨表格 ' + R.pk.files.length + ' 份') +
      '　數量異常學習清單 ' + R.learnedN + ' 條' + (R.skippedByLearn ? '（略過 ' + R.skippedByLearn + ' 項）' : '') +
      '　運費群組：' + R.fr.groups.map(function (g) { return g.skipped ? g.name + '(略過)' : g.name + ' ' + g.n + ' 家'; }).join('、') + '、其他 ' + R.fr.def + ' 免運');

    var h = '';
    // 1. 重量／數量可疑
    var rows1 = '';
    flagged.forEach(function (o) {
      o.flags.forEach(function (f) {
        if (!f.item) { rows1 += '<tr><td>' + esc(o.customer) + '</td><td>' + oLink(o) + '</td><td colspan="4" style="color:#b71c1c">' + esc(f.t) + '</td></tr>'; return; }
        var it = f.item;
        rows1 += '<tr><td>' + esc(o.customer) + '</td><td>' + oLink(o) + '</td><td>' + esc(it.name) + '</td><td>' + esc(it.unit) + '</td><td style="text-align:right">' +
          (it.pk ? fmt(it.pk.qty) + ' → ' : '') + '<b>' + fmt(it.qty) + '</b>' + (it.pk && isFinite(it.pk.kg) ? '<div style="color:#888;font-size:12px">秤 ' + fmt(it.pk.kg) + ' kg</div>' : '') + '</td><td>' +
          it.flags.map(function (x) { return '<div style="color:' + (x.lv > 1 ? '#b71c1c' : '#8a5a00') + '">' + (x.lv > 1 ? '⚠ ' : '？ ') + esc(x.t) + '</div>'; }).join('') + '</td></tr>';
      });
    });
    h += section('⚠ 重量／數量要確認', '#c62828', rows1 ? '<table style="width:100%;border-collapse:collapse" class="mk-mc-t"><tr><th>客戶</th><th>訂單</th><th>品名</th><th>單位</th><th>原訂 → 現在</th><th>原因</th></tr>' + rows1 + '</table>' : '沒有可疑的品項 👍', flagged.length + ' 張單');

    // 2. 實價／外購品
    var rows2 = '';
    zeroO.forEach(function (o) { o.zero.forEach(function (it) {
      rows2 += '<tr><td>' + esc(o.customer) + '</td><td>' + oLink(o) + '</td><td>' + esc(it.name) + (it.note ? '<div style="color:#888;font-size:12px">' + esc(it.note) + '</div>' : '') + '</td><td>' + esc(it.unit) + '</td><td style="text-align:right">' + fmt(it.qty) + '</td></tr>';
    }); });
    h += section('💰 實價／外購品（價格 0，要對照採購單補重量和價格）', '#ef6c00', rows2 ? '<table style="width:100%;border-collapse:collapse" class="mk-mc-t"><tr><th>客戶</th><th>訂單</th><th>品名</th><th>單位</th><th>目前數量</th></tr>' + rows2 + '</table><div style="color:#666;font-size:12px;margin-top:4px">第二階段會在這裡直接輸入重量、價格寫回後台。</div>' : '沒有價格 0 的品項', zeroO.length + ' 張單');

    // 3. 運費
    var rows3 = '';
    frFix.forEach(function (f) {
      var plan = f.want === 0 ? '全部改 0' : (f.orders.length > 1 ? '只留一張收 ' + R.fr.fee + '，其他改 0' : '應收 ' + R.fr.fee);
      var curTxt = f.orders.map(function (o) {
        var p = o.priceInfo;
        if (p) return '運費 ' + p.fee + (p.discount ? '<span style="color:#888">（商家優惠 −' + p.discount + '）</span>' : '');
        return isFinite(o.fee) ? String(o.fee) : '?';
      }).join('<br>');
      var waived = f.want > 0 && f.orders.some(function (o) { return o.priceInfo && o.priceInfo.discount > 0; });
      rows3 += '<tr><td>' + esc(f.customer) + (f.inGroup ? '' : '<div style="color:#888;font-size:12px">預設群組</div>') + '</td><td>' + f.orders.map(oLink).join('<br>') + '</td><td style="text-align:right">' + money(f.sum) + '</td><td style="text-align:right">' + f.thr + '</td><td>' +
        curTxt + '</td><td><b>' + plan + '</b>' + (waived ? '<div style="color:#8a5a00;font-size:12px">目前用商家優惠抵掉運費，如果是特別處理就不用改</div>' : '') + (f.pending ? '<div style="color:#8a5a00;font-size:12px">有實價品還沒補，金額可能再變</div>' : '') + '</td></tr>';
    });
    h += section('🚚 運費要調整（同客戶當天合併）', '#1565c0', rows3 ? '<table style="width:100%;border-collapse:collapse" class="mk-mc-t"><tr><th>客戶</th><th>訂單</th><th>當天合計</th><th>免運門檻</th><th>目前運費</th><th>應該</th></tr>' + rows3 + '</table>' : '運費都正確 👍', frFix.length + ' 家');

    // 4. 沒問題 → 勾選後一鍵改成已送達
    var canDv = function (o) { return /^(已接單|揀貨完成|配送中)$/.test(o.status); };
    var dvN = okO.filter(canDv).length;
    h += section('✅ 沒發現問題的訂單', '#2e7d4f', okO.length ? okO.map(function (o) {
      return '<label style="display:inline-block;margin:2px 12px 2px 0;cursor:pointer">' +
        (canDv(o) ? '<input type="checkbox" class="mk-mc-dv" value="' + esc(o.id) + '"> ' : '') +
        esc(o.customer) + ' ' + oLink(o) + ' <span class="mk-mc-dvst" data-id="' + esc(o.id) + '" style="color:#888;font-size:12px">' + (o.status !== '已接單' ? esc(o.status) : '') + '</span></label>';
    }).join('') +
      (dvN ? '<div style="margin-top:8px;display:flex;gap:10px;align-items:center"><a href="#" id="mk-mc-dvall" style="color:#2e7d4f;font-size:13px">全選（' + dvN + ' 張）</a><button id="mk-mc-dvgo" style="padding:8px 16px;background:#2e7d4f;color:#fff;border:0;border-radius:6px;font-size:15px;cursor:pointer">把勾選的 0 張改成「已送達」</button><span id="mk-mc-dvmsg" style="font-size:13px"></span></div>' +
        '<div style="color:#666;font-size:12px;margin-top:4px">有問題的訂單（上面紅色、橘色）不在這裡，處理好後重新按一次「會計早上核對」。</div>' : '') : '沒有', okO.length + ' 張');
    $('mk-mc-body').innerHTML = '<style>.mk-mc-t th{background:#f5f5f5;text-align:left;padding:4px 6px;font-size:13px;position:sticky;top:0}.mk-mc-t td{border-top:1px solid #eee;padding:4px 6px;vertical-align:top;font-size:13px}</style>' + h;
    var go = $('mk-mc-dvgo');
    if (go) go.onclick = function () {
      var n = document.querySelectorAll('.mk-mc-dv:checked').length;
      if (!n) { $('mk-mc-dvmsg').textContent = '請先勾選訂單'; return; }
      // 兩段確認：第一次按顯示確認，再按一次才執行
      if (go.dataset.armed !== '1') {
        go.dataset.armed = '1'; go.style.background = '#c62828';
        go.textContent = '確定把 ' + n + ' 張改成已送達？再按一次執行（改了就不能退回）';
        return;
      }
      go.textContent = '處理中…';
      deliverPicked();
    };
    function resetGo() { if (go) { go.dataset.armed = ''; go.style.background = '#2e7d4f'; go.textContent = '把勾選的 ' + document.querySelectorAll('.mk-mc-dv:checked').length + ' 張改成「已送達」'; } }
    [].forEach.call(document.querySelectorAll('.mk-mc-dv'), function (c) { c.onchange = resetGo; });
    var all = $('mk-mc-dvall');
    if (all) all.onclick = function (e) {
      e.preventDefault();
      var cbs = document.querySelectorAll('.mk-mc-dv'), on = [].every.call(cbs, function (c) { return c.checked; });
      [].forEach.call(cbs, function (c) { c.checked = !on; });
      resetGo();
    };
  }
  window.__MK_MC_RENDER = function () { render(); }; // 維護者除錯用

  /* 測試用：window.__MK_MC_DATE 可指定到貨日 */
  if (window.__MK_MC_DATE) { DATE = window.__MK_MC_DATE; $('mk-mc-date').textContent = '到貨日 ' + DATE; }
  run();
})();
