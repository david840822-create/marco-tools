/* 馬可小幫手：更新批次價格（GitHub 上的 price.js）
 * 取代人工流程：批次「匯出訂單金額數量」→ 把當天價格檔「定價」A～L 貼到「盤價-定價」→ 存檔 →
 *               列表頁「匯入訂單金額數量」。
 * 工具做法：
 *   1. 向 Google Apps Script（每日報價自動備份 專案的網路程式）列出最近的價格檔，下拉選單預設最新的；
 *      選的不是「今天」（作業日：凌晨 0～6 點算前一天）就顯示警示，按更新時再確認一次。
 *      需要密碼，密碼只存在這台電腦的瀏覽器。
 *   2. 每個勾選的批次：隱藏視窗匯出 Excel（攔下來不存檔）→ 填入「盤價-定價」→
 *      照 Excel 同一套公式算出「訂單資料」N 欄價格並寫進去 → 用列表頁的匯入按鈕匯入 →
 *      再匯出一次，核對後台價格是否跟價格檔一致。
 *   3. 只有異常才跳紅色通知：找不到的商品、價格檔是 0（不改，請手動確認）、匯入後價格不一致。
 */
(async function () {
  var PRICE_API = 'https://script.google.com/macros/s/AKfycbwkph6A7dMEcndMv1WhczRhX0O0EIbZ3XPCgC4DUuAjybAHYP9zRkVJ9c_BN6jWUexW/exec';
  var KEY_STORE = 'mk-price-key';
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var ORIGIN = location.origin;
  if (!/super-marco\.com$/.test(location.hostname)) { alert('請在馬可供應商後台的頁面上使用。'); return; }
  var old = document.getElementById('mk-price-panel');
  if (old) old.remove();

  /* ---------- 小工具 ---------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function txt(el) { return (el && el.innerText || '').replace(/\s+/g, ' ').trim(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function unesc(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(+d); }).replace(/&amp;/g, '&');
  }
  function getKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
  function setKey(k) { try { if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE); } catch (e) {} }
  async function waitFor(fn, timeout, step) {
    var t0 = Date.now();
    while (Date.now() - t0 < (timeout || 15000)) {
      var r = null; try { r = fn(); } catch (e) { r = null; }
      if (r) return r;
      await sleep(step || 250);
    }
    return null;
  }
  function loadFrame(url, ready, timeout) {
    timeout = timeout || 40000;
    return new Promise(function (resolve, reject) {
      var f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-12000px;top:0;width:1400px;height:1000px;visibility:hidden;';
      f.src = url;
      document.body.appendChild(f);
      var t0 = Date.now();
      var iv = setInterval(function () {
        var r = null;
        try { r = ready(f.contentDocument, f.contentWindow); } catch (e) { r = null; }
        if (r) { clearInterval(iv); resolve({ frame: f, result: r }); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); f.remove(); reject(new Error('載入逾時')); }
      }, 250);
    });
  }
  function stableCounter(getCount, times) {
    var last = -1, same = 0;
    return function (doc) {
      var n = getCount(doc);
      if (n > 0 && n === last) same++; else same = 0;
      last = n;
      return same >= (times || 3) ? n : 0;
    };
  }
  function btnByText(doc, t) {
    return [].find.call(doc.querySelectorAll('button, label[role=button]'), function (b) { return b.innerText.replace(/\s+/g, '') === t; });
  }

  /* ---------- 批次清單（跟產生出貨單一樣） ---------- */
  function readBatchList(doc) {
    var seen = {}, list = [];
    doc.querySelectorAll('a[href*="/delivery-batch/edit/"]').forEach(function (a) {
      var m = /\/delivery-batch\/edit\/(\d+)$/.exec(a.getAttribute('href') || '');
      var tr = a.closest('tr');
      if (!m || !tr || seen[m[1]]) return;
      seen[m[1]] = 1;
      var t = txt(tr);
      var no = (/\b(\d{8})\b/.exec(t) || [])[1] || '';
      var dt = (/(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2})/.exec(t) || []);
      var status = (/(進行中|已結束|已停止|已中斷|[^\s]*完成)/.exec(t) || [])[1] || '';
      list.push({ id: m[1], no: no, date: dt[1] || '', time: dt[2] || '', status: status });
    });
    return list;
  }

  /* ---------- zip（xlsx 就是 zip）讀寫，不用外部套件 ---------- */
  async function pipe(u8, stream) {
    return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer());
  }
  async function unzip(buf) {
    var dv = new DataView(buf), u8 = new Uint8Array(buf), out = [];
    var i = buf.byteLength - 22;
    while (i >= 0 && dv.getUint32(i, true) !== 0x06054b50) i--;
    if (i < 0) throw new Error('匯出的檔案不是有效的 Excel');
    var n = dv.getUint16(i + 10, true), off = dv.getUint32(i + 16, true);
    for (var k = 0; k < n; k++) {
      if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('Excel 檔結構不正確');
      var method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
      var nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
      var loff = dv.getUint32(off + 42, true);
      var name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nlen));
      var start = loff + 30 + dv.getUint16(loff + 26, true) + dv.getUint16(loff + 28, true);
      var data = u8.subarray(start, start + csize);
      if (method === 0) data = data.slice();
      else if (method === 8) data = await pipe(data, new DecompressionStream('deflate-raw'));
      else throw new Error('Excel 檔用了不支援的壓縮方式');
      out.push({ name: name, data: data });
      off += 46 + nlen + elen + clen;
    }
    return out;
  }
  var CRC_T = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) { var c = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  async function zip(files) {
    var enc = new TextEncoder(), parts = [], central = [], off = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i], nb = enc.encode(f.name), crc = crc32(f.data);
      var comp = await pipe(f.data, new CompressionStream('deflate-raw'));
      var lh = new Uint8Array(30 + nb.length), d = new DataView(lh.buffer);
      d.setUint32(0, 0x04034b50, true); d.setUint16(4, 20, true); d.setUint16(6, 0x0800, true); d.setUint16(8, 8, true);
      d.setUint16(10, 0, true); d.setUint16(12, 0x21, true); d.setUint32(14, crc, true);
      d.setUint32(18, comp.length, true); d.setUint32(22, f.data.length, true); d.setUint16(26, nb.length, true); d.setUint16(28, 0, true);
      lh.set(nb, 30);
      var ch = new Uint8Array(46 + nb.length), c = new DataView(ch.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 8, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true);
      c.setUint32(20, comp.length, true); c.setUint32(24, f.data.length, true); c.setUint16(28, nb.length, true);
      c.setUint32(42, off, true); ch.set(nb, 46);
      parts.push(lh, comp); central.push(ch);
      off += lh.length + comp.length;
    }
    var cdSize = central.reduce(function (s, x) { return s + x.length; }, 0);
    var eo = new Uint8Array(22), e = new DataView(eo.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
    return new Blob(parts.concat(central, [eo]), { type: XLSX_MIME });
  }

  /* ---------- xlsx 內容 ---------- */
  function openBook(files) {
    var map = {}, dec = new TextDecoder();
    files.forEach(function (f) { map[f.name] = f; });
    function get(name) { return map[name] ? dec.decode(map[name].data) : ''; }
    function put(name, s) { map[name].data = new TextEncoder().encode(s); }
    var shared = [];
    get('xl/sharedStrings.xml').replace(/<si>([\s\S]*?)<\/si>/g, function (m, si) {
      var t = ''; si.replace(/<t[^>]*>([\s\S]*?)<\/t>/g, function (mm, x) { t += x; }); shared.push(unesc(t)); return m;
    });
    var wb = get('xl/workbook.xml'), rels = get('xl/_rels/workbook.xml.rels');
    function sheetPath(name) {
      var m = new RegExp('<sheet [^>]*name="' + name + '"[^>]*r:id="([^"]+)"').exec(wb);
      if (!m) return null;
      var t = new RegExp('<Relationship [^>]*Id="' + m[1] + '"[^>]*Target="([^"]+)"').exec(rels) ||
              new RegExp('<Relationship [^>]*Target="([^"]+)"[^>]*Id="' + m[1] + '"').exec(rels);
      return t ? 'xl/' + t[1].replace(/^\/?xl\//, '') : null;
    }
    return { files: files, get: get, put: put, shared: shared, sheetPath: sheetPath, wbPath: 'xl/workbook.xml' };
  }
  function cellValue(book, attrs, body) {
    var t = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
    var v = (/<v>([\s\S]*?)<\/v>/.exec(body || '') || [])[1];
    if (t === 's') return v != null ? book.shared[+v] : '';
    if (t === 'inlineStr') { var it = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body || ''); return it ? unesc(it[1]) : ''; }
    if (t === 'str') return v != null ? unesc(v) : '';
    return v != null && v !== '' ? Number(v) : '';
  }
  /* 讀「訂單資料」：{rowNo: {A:..,B:..,...}} */
  function readOrders(book) {
    var p = book.sheetPath('訂單資料');
    if (!p) throw new Error('匯出檔裡找不到「訂單資料」分頁');
    var xml = book.get(p), rows = [];
    xml.replace(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g, function (m, rn, inner) {
      var row = { r: +rn };
      inner.replace(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, function (mm, col, attrs, body) { row[col] = cellValue(book, attrs, body); return mm; });
      rows.push(row);
      return m;
    });
    return { path: p, xml: xml, header: rows[0] || {}, rows: rows.slice(1) };
  }

  /* ---------- 計算：跟 Excel 公式一樣 ----------
   * 專屬價格=O → 空白（不改）；否則用商品ID 找「盤價-定價」那一列，取「分組價-」+客戶標籤 那一欄。 */
  function buildPriceIndex(price) {
    var col = {};
    price.header.forEach(function (h, i) { col[String(h).trim()] = i; });
    var byId = {};
    price.rows.forEach(function (r) { var id = String(r[0]).trim(); if (id && !(id in byId)) byId[id] = r; });
    return { col: col, byId: byId };
  }
  function expectPrice(ix, row) {
    if (String(row.J).trim().toUpperCase() === 'O') return { kind: 'exclusive' };
    var r = ix.byId[String(row.C).trim()];
    var ci = ix.col['分組價-' + String(row.E).trim()];
    if (!r) return { kind: 'notFound' };
    if (ci == null) return { kind: 'noTier' };
    var v = r[ci];
    if (v === '' || v == null) return { kind: 'blank' };
    var n = Number(v);
    if (!isFinite(n)) return { kind: 'blank' };
    if (n === 0) return { kind: 'zero' };
    return { kind: 'ok', value: n };
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  /* 改匯出檔：填「盤價-定價」＋把 N 欄算好的價格寫進去 */
  function fillBook(book, orders, price, ix) {
    /* 1) 盤價-定價：整張蓋掉（等於從 A1 貼上 A～L） */
    var pp = book.sheetPath('盤價-定價');
    if (!pp) throw new Error('匯出檔裡找不到「盤價-定價」分頁');
    var all = [price.header].concat(price.rows), letters = 'ABCDEFGHIJKL';
    var sd = '<sheetData>' + all.map(function (r, i) {
      var rn = i + 1;
      return '<row r="' + rn + '">' + r.slice(0, 12).map(function (v, j) {
        var ref = letters[j] + rn;
        if (v === '' || v == null) return '';
        if (typeof v === 'number' && isFinite(v)) return '<c r="' + ref + '"><v>' + v + '</v></c>';
        return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + esc(String(v)) + '</t></is></c>';
      }).join('') + '</row>';
    }).join('') + '</sheetData>';
    var px = book.get(pp);
    if (/<sheetData\/>/.test(px)) px = px.replace(/<sheetData\/>/, sd);
    else px = px.replace(/<sheetData>[\s\S]*?<\/sheetData>/, sd);
    px = px.replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:L' + all.length + '"/>');
    book.put(pp, px);

    /* 2) 訂單資料 N 欄：保留公式，寫入算好的值（跟 Excel 存檔後一樣） */
    var res = { total: 0, changed: 0, exclusive: 0, notFound: [], zero: [], same: 0, expected: {} };
    var byRow = {};
    orders.rows.forEach(function (row) {
      if (!row.B && !row.A) return;
      res.total++;
      var e = expectPrice(ix, row);
      byRow[row.r] = e;
      var label = (row.D || '') + '／' + (row.H || '') + '（' + (row.I || '') + '）';
      if (e.kind === 'exclusive') res.exclusive++;
      else if (e.kind === 'ok') {
        var want = round2(e.value); // 後台價格只存到小數 2 位（158.3333 → 158.33）
        res.expected[String(row.B)] = want;
        if (Math.abs(Number(row.M) - want) < 0.001) res.same++; else res.changed++;
      }
      else if (e.kind === 'zero') res.zero.push(label);
      else res.notFound.push(label + (e.kind === 'noTier' ? ' [客戶標籤 ' + row.E + ' 沒有對應價格欄]' : ''));
    });
    var missingN = 0;
    var xml = orders.xml.replace(/<row\b([^>]*)\br="(\d+)"([^>]*)>([\s\S]*?)<\/row>/g, function (m, a1, rn, a2, inner) {
      var e = byRow[+rn];
      if (!e) return m;
      var hit = false;
      var ni = inner.replace(/<c r="N(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/, function (cm, n2, attrs, body) {
        hit = true;
        var s = (/\bs="(\d+)"/.exec(attrs) || [])[0] || '';
        var f = (/<f[^>]*>[\s\S]*?<\/f>|<f[^>]*\/>/.exec(body || '') || [''])[0];
        if (e.kind === 'ok') return '<c r="N' + n2 + '"' + (s ? ' ' + s : '') + '>' + f + '<v>' + e.value + '</v></c>';
        return '<c r="N' + n2 + '"' + (s ? ' ' + s : '') + ' t="str">' + f + '<v></v></c>';
      });
      if (!hit) { missingN++; if (e.kind === 'ok') ni = inner + '<c r="N' + rn + '"><v>' + e.value + '</v></c>'; }
      return '<row' + a1 + 'r="' + rn + '"' + a2 + '>' + ni + '</row>';
    });
    book.put(orders.path, xml);
    /* 用 Excel 打開時重新計算（後台匯入讀的是上面寫好的值） */
    var wbx = book.get(book.wbPath);
    if (!/fullCalcOnLoad/.test(wbx)) book.put(book.wbPath, wbx.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"'));
    res.missingN = missingN;
    return res;
  }

  /* ---------- 匯出：隱藏視窗按「匯出訂單金額數量」，把檔案攔下來（不存到電腦） ---------- */
  async function exportBatch(b) {
    var counter = stableCounter(function (d) {
      var rows = d.querySelectorAll('table tbody tr');
      return btnByText(d, '匯出訂單金額數量') && rows.length ? rows.length : 0;
    }, 3);
    var got = await loadFrame(ORIGIN + '/delivery-batch/edit/' + b.id, counter, 45000);
    var f = got.frame, w = f.contentWindow, d = f.contentDocument, captured = null;
    try {
      var oc = w.URL.createObjectURL;
      w.URL.createObjectURL = function (x) { if (x && x.size && /sheet|excel|octet|zip/i.test(x.type || 'octet')) captured = x; return oc.apply(this, arguments); };
      var A = w.HTMLAnchorElement.prototype, ac = A.click, ad = A.dispatchEvent;
      A.click = function () { if (this.download || /^blob:/.test(this.href)) return; return ac.apply(this, arguments); };
      A.dispatchEvent = function (ev) { if (ev && ev.type === 'click' && (this.download || /^blob:/.test(this.href))) return true; return ad.apply(this, arguments); };
      d.addEventListener('click', function (ev) { var a = ev.target && ev.target.closest && ev.target.closest('a[download], a[href^="blob:"]'); if (a) ev.preventDefault(); }, true);
      var btn = btnByText(d, '匯出訂單金額數量');
      if (!btn || btn.disabled) throw new Error('批次 ' + b.no + ' 的「匯出訂單金額數量」不能按');
      btn.click();
      var blob = await waitFor(function () { return captured; }, 45000, 200);
      if (!blob) throw new Error('批次 ' + b.no + ' 匯出逾時');
      return await blob.arrayBuffer();
    } finally { f.remove(); }
  }

  /* ---------- 匯入：列表頁「匯入訂單金額數量」 ---------- */
  function feedbackText(d) {
    var els = d.querySelectorAll('[role=alert], [role=alertdialog], [role=dialog], .MuiSnackbar-root, .MuiAlert-message, .Toastify__toast, .ant-message, .ant-notification');
    return [].map.call(els, function (e) { return txt(e); }).filter(Boolean).join('｜');
  }
  async function importFile(blob, fileName) {
    var got = await loadFrame(ORIGIN + '/delivery-batch/list', function (d) {
      var lab = [].find.call(d.querySelectorAll('label'), function (l) { return l.innerText.replace(/\s+/g, '') === '匯入訂單金額數量'; });
      return lab && lab.querySelector('input[type=file]') && d.querySelector('a[href*="/delivery-batch/edit/"]') ? lab : null;
    }, 45000);
    var f = got.frame, w = f.contentWindow, d = f.contentDocument;
    try {
      var before = feedbackText(d);
      var input = got.result.querySelector('input[type=file]');
      var file = new w.File([blob], fileName, { type: XLSX_MIME });
      var dt = new w.DataTransfer(); dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      input.dispatchEvent(new w.Event('change', { bubbles: true }));
      var msg = await waitFor(function () { var t = feedbackText(d); return t && t !== before ? t : null; }, 60000, 300);
      /* 「匯入結果」視窗的內容可能晚一點才出來：等文字穩定再讀 */
      var last = '', same = 0, t0 = Date.now();
      while (msg && same < 4 && Date.now() - t0 < 15000) {
        await sleep(400);
        var cur = feedbackText(d);
        if (cur === last) same++; else { same = 0; last = cur; }
      }
      return { msg: last || msg || '' };
    } finally { setTimeout(function () { f.remove(); }, 3000); }
  }

  /* 離線測試用（正常使用不會走到） */
  if (typeof window.__MK_PRICE_TEST === 'function') {
    window.__MK_PRICE_TEST({ unzip: unzip, zip: zip, openBook: openBook, readOrders: readOrders, fillBook: fillBook, buildPriceIndex: buildPriceIndex, expectPrice: expectPrice, exportBatch: exportBatch, importFile: importFile, readBatchList: readBatchList });
    return;
  }

  /* ---------- 畫面 ---------- */
  var panel = document.createElement('div');
  panel.id = 'mk-price-panel';
  panel.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;width:380px;max-height:88vh;overflow:auto;background:#fff;border:2px solid #2e7d4f;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);font:14px/1.5 "Microsoft JhengHei",sans-serif;color:#222;padding:14px;';
  panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b style="font-size:16px;color:#2e7d4f">💲 更新批次價格</b><span id="mk-px" style="cursor:pointer;font-size:20px;line-height:1">×</span></div><div id="mk-pbody">讀取批次中…</div><div id="mk-pstatus" style="margin-top:8px;color:#555;font-size:13px;white-space:pre-line"></div><div id="mk-presult"></div>';
  document.body.appendChild(panel);
  panel.querySelector('#mk-px').onclick = function () { panel.remove(); };
  var body = panel.querySelector('#mk-pbody'), statusEl = panel.querySelector('#mk-pstatus'), resultEl = panel.querySelector('#mk-presult');
  function status(s) { statusEl.textContent = s; }

  function askKey(msg) {
    body.innerHTML = '<div style="background:#fff8e1;border:1px solid #f0d27a;border-radius:6px;padding:10px">' + esc(msg || '第一次使用：請負責人輸入「價格密碼」（只存在這台電腦）。') +
      '<div style="margin-top:8px;display:flex;gap:6px"><input id="mk-pkey" type="password" autocomplete="off" style="flex:1;font:inherit;padding:4px 6px" placeholder="價格密碼"><button id="mk-pkey-ok" style="font:inherit;padding:4px 12px;background:#2e7d4f;color:#fff;border:0;border-radius:6px;cursor:pointer">儲存</button></div></div>';
    panel.querySelector('#mk-pkey-ok').onclick = function () {
      var k = panel.querySelector('#mk-pkey').value.trim();
      if (!k) return;
      setKey(k); showBatches();
    };
  }

  var batches = readBatchList(document);
  if (!batches.length) {
    try {
      var g = await loadFrame(ORIGIN + '/delivery-batch/list', stableCounter(function (d) { return readBatchList(d).length; }, 3));
      batches = readBatchList(g.frame.contentDocument); g.frame.remove();
    } catch (e) { body.textContent = '讀不到批次列表，請先到「出貨批次管理」再按一次。'; return; }
  }

  function showBatches() {
    if (!getKey()) { askKey(); return; }
    var html = '<div style="font-size:13px;color:#666">選價格檔、勾選批次，按下去會直接匯入。價格檔每天約 17:00 產生。</div>' +
      '<div style="margin-top:8px"><b>價格檔</b> <select id="mk-pfile" style="font:inherit;padding:3px 4px;max-width:250px"><option value="">讀取中…</option></select>' +
      '<div id="mk-pfwarn" style="margin-top:4px;font-size:13px"></div></div>';
    var lastDate = null;
    batches.forEach(function (b) {
      if (b.date !== lastDate) {
        html += '<div style="margin-top:8px;display:flex;justify-content:space-between"><b style="color:#2e7d4f">' + esc(b.date) + ' 建立</b><a href="#" class="mk-pday" data-date="' + esc(b.date) + '" style="font-size:12px;color:#2e7d4f">整天全選</a></div>';
        lastDate = b.date;
      }
      html += '<label style="display:block;cursor:pointer;padding:2px 0"><input type="checkbox" class="mk-pb" value="' + esc(b.id) + '" data-no="' + esc(b.no) + '" data-date="' + esc(b.date) + '"> ' + esc(b.no) + '　<span style="color:#888">' + esc(b.time) + ' ' + esc(b.status) + '</span> <span class="mk-pst" data-id="' + esc(b.id) + '">' + updTag(b) + '</span></label>';
    });
    html += '<button id="mk-pgo" style="margin-top:10px;width:100%;padding:10px;background:#2e7d4f;color:#fff;border:0;border-radius:6px;font-size:15px;cursor:pointer">更新價格</button>';
    html += '<div style="margin-top:6px;text-align:right"><a href="#" id="mk-pchkey" style="font-size:12px;color:#888">更換價格密碼</a></div>';
    body.innerHTML = html;
    [].forEach.call(panel.querySelectorAll('.mk-pday'), function (a) {
      a.onclick = function (e) {
        e.preventDefault();
        var boxes = [].filter.call(panel.querySelectorAll('.mk-pb'), function (c) { return c.getAttribute('data-date') === a.getAttribute('data-date'); });
        var on = boxes.every(function (c) { return c.checked; });
        boxes.forEach(function (c) { c.checked = !on; });
      };
    });
    panel.querySelector('#mk-pchkey').onclick = function (e) { e.preventDefault(); setKey(''); askKey('請輸入新的價格密碼。'); };
    panel.querySelector('#mk-pgo').onclick = run;
    panel.querySelector('#mk-pfile').onchange = showFileWarn;
    loadFileList();
    loadUpd();
  }

  /* ---------- 價格檔下拉選單 ---------- */
  var fileList = null, today = '';
  function mdLabel(d) { var p = String(d).split('-'); return p.length === 3 ? (+p[1]) + '/' + (+p[2]) : d; }
  async function api(params) {
    var r = await fetch(PRICE_API + '?key=' + encodeURIComponent(getKey()) + params, { redirect: 'follow' });
    return r.json();
  }
  /* ---------- 更新紀錄：哪些批次今天已經用今天的價格檔更新過（三台電腦共用） ---------- */
  var upd = null; // {today, now, log:{批次編號:{at,file,warn}}}
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function batchDay(b) { // 批次建立的作業日 yyyy-MM-dd（凌晨 0～6 點建的算前一天）
    var m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(b.date || '');
    if (!m) return '';
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (b.time && +b.time.slice(0, 2) < 6) d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function updState(b) { // {done, e, wrong}
    var e = upd && upd.log && upd.log[b.no];
    if (!e) return { done: false };
    return { done: e.file === batchDay(b), e: e, wrong: e.file !== batchDay(b) };
  }
  function updTag(b) {
    if (!upd) return '';
    var s = updState(b), day = batchDay(b);
    if (s.done) return '<span style="color:#1b5e20;font-size:12px">✓ 已更新價格 ' + esc(String(s.e.at).slice(11)) + '</span>';
    if (day !== upd.today || /已停止|已中斷/.test(b.status)) return '';
    if (s.wrong) return '<span style="color:#b71c1c;font-size:12px;font-weight:700">⚠ 用了 ' + esc(mdLabel(s.e.file)) + ' 的價格檔</span>';
    return '<span style="color:#b71c1c;font-size:12px;font-weight:700">⚠ 還沒更新價格</span>';
  }
  async function loadUpd() {
    try {
      var seen = [], stop = []; // 順便回報看到的批次（給每天定時寄信提醒用）
      batches.forEach(function (b) { if (/^\d{8}$/.test(b.no)) (/已停止|已中斷/.test(b.status) ? stop : seen).push(b.no); });
      var r = await fetch(PRICE_API + '?action=status&seen=' + seen.slice(0, 30).join(',') + '&stop=' + stop.slice(0, 30).join(','), { redirect: 'follow' });
      var j = await r.json();
      if (j && j.ok) upd = j;
    } catch (e) { upd = null; }
    batches.forEach(function (b) {
      var el = panel.querySelector('.mk-pst[data-id="' + b.id + '"]');
      if (el) el.innerHTML = updTag(b);
    });
  }
  async function logUpd(b, fileDate, warn) {
    try {
      var r = await api('&action=log&batch=' + encodeURIComponent(b.no) + '&file=' + encodeURIComponent(fileDate) + '&warn=' + (warn || 0));
      return !!(r && r.ok);
    } catch (e) { return false; }
  }

  async function loadFileList() {
    var sel = panel.querySelector('#mk-pfile');
    try {
      var res = await api('&action=list');
      if (!res.ok) {
        if (res.badKey) { setKey(''); askKey('價格密碼不對，請負責人重新輸入。'); return; }
        sel.innerHTML = '<option value="">讀不到</option>';
        panel.querySelector('#mk-pfwarn').innerHTML = '<span style="color:#b71c1c">⚠ ' + esc(res.error) + '</span>';
        return;
      }
      fileList = res.files; today = res.today;
      if (!fileList.length) { sel.innerHTML = '<option value="">沒有價格檔</option>'; showFileWarn(); return; }
      sel.innerHTML = fileList.map(function (f, i) {
        return '<option value="' + i + '">' + esc(mdLabel(f.date)) + '　' + esc(((/(\d{3,4})\.xlsx$/.exec(f.name) || [])[1] || f.name)) + (f.date === today ? '（今天）' : '') + '</option>';
      }).join('');
      sel.value = '0';
      showFileWarn();
    } catch (e) {
      sel.innerHTML = '<option value="">讀不到</option>';
      panel.querySelector('#mk-pfwarn').innerHTML = '<span style="color:#b71c1c">⚠ 讀不到價格檔清單：' + esc(e.message) + '</span>';
    }
  }
  function pickedFile() {
    var v = panel.querySelector('#mk-pfile') && panel.querySelector('#mk-pfile').value;
    return fileList && v !== '' && v != null ? fileList[+v] : null;
  }
  function showFileWarn() {
    var w = panel.querySelector('#mk-pfwarn'), f = pickedFile();
    if (!w) return;
    if (!fileList) return;
    if (!f) { w.innerHTML = '<span style="color:#b71c1c">⚠ 找不到價格檔</span>'; return; }
    if (f.date === today) { w.innerHTML = '<span style="color:#1b5e20">✓ 是今天（' + esc(mdLabel(today)) + '）的價格檔</span>'; return; }
    var newestToday = fileList[0] && fileList[0].date === today;
    w.innerHTML = '<div style="background:#fdecea;border:1px solid #e57373;color:#b71c1c;border-radius:6px;padding:6px 8px">⚠ 這<b>不是今天（' + esc(mdLabel(today)) + '）</b>的價格檔，是 ' + esc(mdLabel(f.date)) + ' 的。' +
      (newestToday ? '' : '<br>今天的價格檔還沒產生（每天約 17:00）。') + '</div>';
  }

  async function run() {
    var btn = this;
    var picked = [].slice.call(panel.querySelectorAll('.mk-pb:checked')).map(function (c) {
      return batches.filter(function (b) { return b.id === c.value; })[0] || { id: c.value, no: c.getAttribute('data-no') };
    });
    if (!picked.length) { status('請先勾選批次'); return; }
    /* 今天已經更新過的批次：再更新會把手動改過的價格蓋掉，先確認 */
    var again = picked.filter(function (b) { return updState(b).done; });
    if (again.length && !confirm('下面的批次已經更新過價格：\n' + again.map(function (b) { return b.no + '（' + String(updState(b).e.at).slice(11) + ' 更新）'; }).join('\n') +
      '\n\n再更新一次，會把「手動改過的價格」蓋回價格檔的價格。\n確定要再更新一次嗎？')) { status('已取消'); return; }
    btn.disabled = true; btn.style.opacity = .6;
    resultEl.innerHTML = '';
    var T0 = Date.now();
    try {
      var pf = pickedFile();
      if (!pf) { status('請先選價格檔'); return; }
      if (pf.date !== today && !confirm('選的是 ' + mdLabel(pf.date) + ' 的價格檔，不是今天（' + mdLabel(today) + '）的。\n\n確定要用這個價格檔更新嗎？')) { status('已取消'); return; }
      status('讀取價格檔 ' + mdLabel(pf.date) + '…');
      var price = await api('&id=' + encodeURIComponent(pf.id));
      if (!price.ok) {
        if (price.badKey) { setKey(''); askKey('價格密碼不對，請負責人重新輸入。'); status(''); return; }
        status(''); resultEl.innerHTML = box('#b71c1c', '⚠ ' + esc(price.error));
        return;
      }
      var ix = buildPriceIndex(price);
      var head = '價格檔：' + price.name + '（' + price.rows.length + ' 個商品）' + (price.date !== today ? '　⚠ 不是今天的' : '');
      var reports = [];
      for (var i = 0; i < picked.length; i++) {
        var b = picked[i], rep = { b: b, warn: [] };
        reports.push(rep);
        try {
          status(head + '\n批次 ' + b.no + '（' + (i + 1) + '/' + picked.length + '）：匯出中…');
          var buf = await exportBatch(b);
          status(head + '\n批次 ' + b.no + '：填入價格…');
          var book = openBook(await unzip(buf));
          var orders = readOrders(book);
          if (!orders.rows.length) { rep.warn.push('批次裡沒有訂單品項，略過'); continue; }
          var res = fillBook(book, orders, price, ix);
          rep.res = res;
          if (res.missingN) rep.warn.push('有 ' + res.missingN + ' 列沒有「價格」欄，請通知維護者');
          var out = await zip(book.files);
          status(head + '\n批次 ' + b.no + '：匯入中…');
          var imp = await importFile(out, '訂單金額數量-' + b.no + '-自動更新價格.xlsx');
          rep.importMsg = imp.msg;
          if (/失敗|錯誤|error|fail/i.test(imp.msg)) rep.warn.push('匯入訊息：' + imp.msg);
          status(head + '\n批次 ' + b.no + '：核對後台價格…');
          await sleep(1500);
          var chk = readOrders(openBook(await unzip(await exportBatch(b))));
          var bad = [];
          chk.rows.forEach(function (row) {
            var want = res.expected[String(row.B)];
            if (want == null) return;
            if (Math.abs(Number(row.M) - want) > 0.001) bad.push((row.D || '') + '／' + (row.H || '') + '：後台 ' + row.M + '，價格檔 ' + want);
          });
          rep.bad = bad;
          if (bad.length) rep.warn.push('匯入後有 ' + bad.length + ' 個品項價格跟價格檔不一致');
          /* 記錄「這個批次已更新」（給每天的提醒用） */
          if (!/失敗|錯誤|error|fail/i.test(imp.msg)) {
            if (!(await logUpd(b, price.date, bad.length + res.notFound.length + res.zero.length))) rep.warn.push('更新紀錄沒存到（價格已更新，但提醒可能會顯示「還沒更新」）');
          }
        } catch (e) { rep.warn.push('發生錯誤：' + e.message); }
      }
      status(head + '\n完成，用時 ' + Math.round((Date.now() - T0) / 1000) + ' 秒');
      resultEl.innerHTML = reports.map(render).join('');
      loadUpd();
    } catch (e) {
      status(''); resultEl.innerHTML = box('#b71c1c', '⚠ 發生錯誤：' + esc(e.message));
    } finally { btn.disabled = false; btn.style.opacity = 1; }
  }

  function box(color, html) { return '<div style="margin-top:8px;border:1px solid ' + color + ';color:' + color + ';border-radius:6px;padding:8px;font-size:13px">' + html + '</div>'; }
  function list(title, arr) {
    if (!arr || !arr.length) return '';
    return '<div style="margin-top:4px"><b>' + esc(title) + '（' + arr.length + '）</b><div style="max-height:140px;overflow:auto;color:#333">' + arr.map(function (x) { return '・' + esc(x); }).join('<br>') + '</div></div>';
  }
  function render(rep) {
    var r = rep.res;
    var anomaly = rep.warn.length || (r && (r.notFound.length || r.zero.length));
    var html = '<b>批次 ' + esc(rep.b.no) + '</b>' + (anomaly ? '　⚠ 有異常' : '　✓ 完成，價格一致');
    if (r) html += '<div style="color:#333">共 ' + r.total + ' 個品項：價格有變 ' + r.changed + '、本來就一樣 ' + r.same + '、專屬價不改 ' + r.exclusive + '</div>';
    html += rep.warn.map(function (w) { return '<div>⚠ ' + esc(w) + '</div>'; }).join('');
    if (r) {
      html += list('價格檔裡沒有這個商品、或價格空白（後台維持原價，請手動確認）', r.notFound);
      html += list('價格檔填 0 的商品（沒有改成 0，後台維持原價，請手動確認）', r.zero);
    }
    html += list('匯入後價格不一致', rep.bad);
    if (rep.importMsg) html += '<div style="color:#666;margin-top:4px">後台訊息：' + esc(rep.importMsg) + '</div>';
    return box(anomaly ? '#b71c1c' : '#1b5e20', html);
  }

  showBatches();
})();
