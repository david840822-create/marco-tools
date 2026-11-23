/* 馬可後台：依車號排序列印出貨明細（書籤小工具）
 * 用法：在 supply-admin.super-marco.com 任一頁按書籤 → 勾選批次 → 產生出貨單 → 列印
 * 原理：用後台自己的頁面（隱藏 iframe）讀取每個批次的訂單與車次，
 *      再載入官方「出貨明細」版面，把每張單依車次 A01→A02→…→B01… 重新排列合併成一份。
 */
(async function () {
  var ORIGIN = location.origin;
  if (!/super-marco\.com$/.test(location.hostname)) {
    alert('請在馬可供應商後台（supply-admin.super-marco.com）的頁面上使用這個書籤。');
    return;
  }
  var old = document.getElementById('mk-sort-panel');
  if (old) old.remove();

  /* ---------- 小工具 ---------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function txt(el) { return (el && el.innerText || '').replace(/\s+/g, ' ').trim(); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

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
        else if (Date.now() - t0 > timeout) { clearInterval(iv); f.remove(); reject(new Error('載入逾時：' + url)); }
      }, 200);
    });
  }

  /* 等到某個數量連續穩定 N 次才算載入完成 */
  function stableCounter(getCount, times) {
    var last = -1, same = 0;
    return function (doc) {
      var n = getCount(doc);
      if (n > 0 && n === last) same++; else same = 0;
      last = n;
      return same >= (times || 3) ? n : 0;
    };
  }

  function rowOrderId(tr) {
    var k = Object.keys(tr).find(function (k) { return k.indexOf('__reactFiber') === 0; });
    var f = k && tr[k];
    for (var i = 0; i < 8 && f; i++) {
      if (typeof f.key === 'string' && /^data-\d+$/.test(f.key)) return f.key.slice(5);
      f = f.return;
    }
    return null;
  }

  function carKey(car) {
    var m = /^\s*([A-Za-z])\s*0*(\d*)\s*$/.exec(car || '') || /([A-Za-z])\s*0*(\d+)/.exec(car || '');
    if (!m) return { letter: '~', num: 9999, label: car || '未分車' };
    var L = m[1].toUpperCase();
    if (!m[2]) return { letter: L, num: 9998, label: L };
    return { letter: L, num: parseInt(m[2], 10), label: L + String(m[2]).padStart(2, '0') };
  }

  /* ---------- 出貨單客製（要改名單或文字，改這裡就好） ----------
   * NO_PRICE   預算制客戶：出貨單不印單價、金額、總價。客戶名稱（去掉空白）「包含」其中一個就算。
   * PRICE_NOTE 其他客戶：右側備註欄印的說明（\n 換行）。
   * COL_W      欄寬：序號、品名、數量/單位、單價、金額、備註（加起來 100%）。 */
  var NO_PRICE = ['勝智老人長期照顧中心', '慈恩老人養護中心', '佳恩(清泉)長照', '潭秀幼兒園', '廍子幼兒園'];
  var PRICE_NOTE = '※ 價格僅供核對\n代購等品項價格可能調整，實際金額以系統帳單為準。';
  var COL_W = ['4%', '30%', '24%', '8%', '9%', '25%'];
  var MK_CSS = '.product-table td.mk-note-td{border:0!important;padding:0 0 0 6px!important;vertical-align:top!important}'
    + '.product-table thead th.mk-note-h{padding-left:6px!important}'
    + '.mk-note-box{border:0.5px solid #000;border-radius:2px;padding:2px 5px;margin-top:2px;font-size:10.5px;line-height:1.35;color:#000;font-weight:400;text-align:left;white-space:normal;word-break:break-all}'
    + '.mk-note-box b{font-weight:700}'
    /* 長品名、長單位：自動換行，不會擠到隔壁欄 */
    + '.product-table tbody td{white-space:normal!important;overflow-wrap:anywhere;word-break:break-word}'
    /* 抬頭：只留 客戶名稱｜配送日期｜車號 */
    + '.customer-section .customer-grid.mk-grid{grid-template-columns:1fr auto auto!important}'
    + '.customer-grid.mk-grid .info-item{padding:3px 10px!important}'
    + '.customer-grid.mk-grid .mk-name .info-value{font-size:20px!important;font-weight:700!important}'
    + '.customer-grid.mk-grid .mk-date .info-value{font-size:20px!important;font-weight:700!important}'
    + '.customer-grid.mk-grid .info-item.car-number{font-size:32px!important;min-width:88px;white-space:nowrap;font-family:"Noto Sans TC","Microsoft JhengHei",sans-serif!important;font-weight:700!important}'
    + '.delivery-section.mk-ds .delivery-address:first-child{max-width:74%!important;flex:1 1 auto}'
    + '.mk-hot .info-label{font-weight:700!important}'
    + '.mk-hot .info-value{font-size:14px!important;font-weight:700!important}';
  var CAR_NUM = true; /* 車號方塊改顯示：A→1車、B→2車、C→3車… */

  function lab(it) { var l = it.querySelector('.info-label'); return l ? l.textContent.replace(/\s+/g, '') : ''; }
  /* 抬頭大調整：拿掉客戶編號、配送時段；日期放大；有填的配送備註／訂單備註加粗；車號改數字 */
  function headerV2(sec) {
    var grid = sec.querySelector('.customer-grid');
    if (grid) {
      grid.classList.add('mk-grid');
      [].slice.call(grid.querySelectorAll('.info-item')).forEach(function (it) {
        var l = lab(it);
        if (l === '客戶編號' || l === '配送時段') it.remove();
        else if (l === '客戶名稱') it.classList.add('mk-name');
        else if (l === '配送日期') it.classList.add('mk-date');
      });
      var car = grid.querySelector('.car-number');
      var m = car && /^\s*([A-Za-z])\s*$/.exec(car.textContent);
      if (CAR_NUM && m) car.textContent = (m[1].toUpperCase().charCodeAt(0) - 64) + '車';
    }
    var ds = sec.querySelector('.delivery-section');
    if (ds) ds.classList.add('mk-ds');
    [].forEach.call(sec.querySelectorAll('.delivery-section .info-item'), function (it) {
      var l = lab(it), v = it.querySelector('.info-value');
      var t = v ? v.textContent.trim() : '';
      if ((l === '配送備註' || l === '訂單備註') && t && t !== '-') it.classList.add('mk-hot');
    });
  }

  function nameKey(x) { return String(x || '').replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').toLowerCase(); }
  function isNoPrice(name) {
    var n = nameKey(name);
    return !!n && NO_PRICE.some(function (x) { return x && n.indexOf(nameKey(x)) >= 0; });
  }
  /* 改出貨單版面：欄位靠攏、右邊多一欄備註；預算制客戶拿掉價格 */
  function customize(sec, noPrice) {
    var doc = sec.ownerDocument;
    var table = sec.querySelector('table.product-table') || sec.querySelector('table');
    if (!table) return;
    headerV2(sec);
    var cg = table.querySelector('colgroup');
    if (cg) {
      var col = doc.createElement('col'); col.className = 'mk-col-note'; cg.appendChild(col);
      [].forEach.call(cg.children, function (c, i) { if (COL_W[i]) c.style.setProperty('width', COL_W[i], 'important'); });
    }
    [].forEach.call(table.querySelectorAll('thead th[colspan]'), function (th) {
      var n = +th.getAttribute('colspan'); if (n >= 5) th.setAttribute('colspan', n + 1);
    });
    var hr = table.querySelector('thead tr.customer-header') || [].slice.call(table.querySelectorAll('thead tr')).pop();
    if (hr) { var th = doc.createElement('th'); th.className = 'mk-note-h'; th.textContent = noPrice ? '' : '備註'; hr.appendChild(th); }
    [].forEach.call(table.querySelectorAll('tbody tr'), function (tr) {
      var td = doc.createElement('td'); td.className = 'mk-note-td'; tr.appendChild(td);
    });
    if (noPrice) {
      [].forEach.call(table.querySelectorAll('th.col-price, th.col-amount, td.col-price, td.col-amount'), function (el) { el.textContent = ''; });
      [].forEach.call(sec.querySelectorAll('.summary-section'), function (el) { el.remove(); });
      sec.setAttribute('data-mk-noprice', '1');
    }
  }
  /* 切頁之後：每一頁的備註欄合併成一格，放說明文字 */
  function placeNote(html) {
    var t = document.createElement('template');
    t.innerHTML = html;
    var sec = t.content.firstElementChild;
    if (!sec) return html;
    var cells = sec.querySelectorAll('tbody td.mk-note-td');
    if (!cells.length || sec.getAttribute('data-mk-noprice')) return html;
    cells[0].setAttribute('rowspan', cells.length);
    var lines = PRICE_NOTE.split('\n');
    cells[0].innerHTML = '<div class="mk-note-box"><b>' + esc(lines[0]) + '</b>' + lines.slice(1).map(function (l) { return '<br>' + esc(l); }).join('') + '</div>';
    for (var i = 1; i < cells.length; i++) cells[i].remove();
    return sec.outerHTML;
  }

  /* ---------- 長訂單分頁：每一頁都有完整抬頭 ----------
   * 紙張 210×140mm、邊界 2mm → 可印區 206×136mm。
   * 用隱藏 iframe 套「列印用 CSS」量每張單的高度，超過一頁就自己切開，
   * 每一頁都複製抬頭（客戶、地址、車號），並標上「第 1/2 頁」。 */
  var PAGE_W_MM = 206, PAGE_H_MM = 136, SAFE_MM = 8;

  function markPage(sec, name, p, n) {
    var doc = sec.ownerDocument;
    var tag = doc.createElement('span');
    tag.className = 'mk-pg';
    tag.textContent = '（第 ' + p + '/' + n + ' 頁）';
    tag.setAttribute('style', 'font-weight:700;margin-left:4px;white-space:nowrap');
    var head = sec.querySelector('thead') || sec;
    var target = null;
    if (name) {
      [].some.call(head.querySelectorAll('*'), function (el) {
        if (!el.children.length && el.textContent.trim() === name) { target = el; return true; }
        return false;
      });
    }
    if (target) { target.appendChild(tag); return; }
    var th = head.querySelector('th') || head;
    th.insertBefore(tag, th.firstChild);
  }

  async function paginate(list, css, open, close, bodyCls) {
    var f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:-12000px;top:0;width:1200px;height:2000px;visibility:hidden;';
    document.body.appendChild(f);
    var d = f.contentDocument;
    d.open();
    d.write('<!doctype html><html><head><meta charset="utf-8"><base href="' + ORIGIN + '/">'
      + '<style>' + css.replace(/@media\s+print/gi, '@media all') + '</style>'
      + '<style>html,body{margin:0!important;padding:0!important}body{width:' + PAGE_W_MM + 'mm!important}</style>'
      + '</head><body class="' + esc(bodyCls || '') + '">' + open + list.map(function (s) { return s.html; }).join('') + close + '</body></html>');
    d.close();
    try { await d.fonts.ready; } catch (e) {}
    await sleep(400);
    var limit = (PAGE_H_MM - SAFE_MM) * 96 / 25.4;
    var secs = d.querySelectorAll('.product-section');
    var out = [];
    list.forEach(function (s, i) {
      var sec = secs[i];
      var table = sec && sec.querySelector('table');
      var tbody = table && table.querySelector('tbody');
      var total = sec ? sec.getBoundingClientRect().height : 0;
      if (!tbody || total <= limit) { s.pages = 1; out.push(s); return; }
      var rows = [].slice.call(tbody.rows);
      var hs = rows.map(function (r) { return r.getBoundingClientRect().height; });
      var tableH = table.getBoundingClientRect().height;
      var overhead = tableH - tbody.getBoundingClientRect().height; /* 抬頭 + 欄位標題 */
      var tail = total - tableH;                                     /* 合計列 */
      var chunks = [], cur = [], used = overhead;
      rows.forEach(function (r, idx) {
        if (cur.length && used + hs[idx] > limit) { chunks.push(cur); cur = []; used = overhead; }
        cur.push(idx); used += hs[idx];
      });
      if (used + tail > limit && cur.length > 1) {
        var moved = [];
        while (cur.length > 1 && used + tail > limit) { var k = cur.pop(); used -= hs[k]; moved.unshift(k); }
        chunks.push(cur); cur = moved;
      }
      chunks.push(cur);
      if (chunks.length < 2) { s.pages = 1; out.push(s); return; }
      chunks.forEach(function (ch, ci) {
        var c = sec.cloneNode(true);
        var cb = c.querySelector('tbody');
        [].slice.call(cb.rows).forEach(function (r, idx) { if (ch.indexOf(idx) < 0) r.remove(); });
        if (ci < chunks.length - 1) {
          [].slice.call(c.children).forEach(function (el) { if (el.tagName !== 'TABLE') el.remove(); });
        }
        markPage(c, s.o.name, ci + 1, chunks.length);
        out.push({ html: c.outerHTML, o: s.o, k: s.k, seq: s.seq, page: ci + 1, pages: chunks.length });
      });
    });
    f.remove();
    return out;
  }

  /* ---------- 取得批次清單 ---------- */
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
      var status = (/(進行中|已結束|已停止|[^\s]*完成)/.exec(t) || [])[1] || '';
      list.push({ id: m[1], no: no, date: dt[1] || '', time: dt[2] || '', status: status });
    });
    return list;
  }

  var panel = document.createElement('div');
  panel.id = 'mk-sort-panel';
  panel.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;width:340px;max-height:85vh;overflow:auto;background:#fff;border:2px solid #2e7d4f;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);font:14px/1.5 "Microsoft JhengHei",sans-serif;color:#222;padding:14px;';
  panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b style="font-size:16px;color:#2e7d4f">依車號列印出貨單</b><span id="mk-x" style="cursor:pointer;font-size:20px;line-height:1">×</span></div><div id="mk-body">讀取批次中…</div><div id="mk-status" style="margin-top:8px;color:#555;font-size:13px;white-space:pre-line"></div>';
  document.body.appendChild(panel);
  panel.querySelector('#mk-x').onclick = function () { panel.remove(); };
  var body = panel.querySelector('#mk-body');
  var statusEl = panel.querySelector('#mk-status');
  function status(s) { statusEl.textContent = s; }

  var batches = readBatchList(document);
  if (!batches.length) {
    try {
      var got = await loadFrame(ORIGIN + '/delivery-batch/list', stableCounter(function (d) { return readBatchList(d).length; }, 3));
      batches = readBatchList(got.frame.contentDocument);
      got.frame.remove();
    } catch (e) {
      body.textContent = '讀不到批次列表，請先到「出貨批次管理」列表頁再按一次書籤。';
      return;
    }
  }

  /* 全部不勾，使用者自己勾要列印的批次 */
  var html = '<div style="font-size:13px;color:#666;margin-bottom:6px">請勾選要列印的批次（可以勾好幾個）：</div>';
  var lastDate = null;
  batches.forEach(function (b) {
    if (b.date !== lastDate) {
      html += '<div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center"><b style="color:#2e7d4f">' + esc(b.date) + ' 建立</b><a href="#" class="mk-day" data-date="' + esc(b.date) + '" style="font-size:12px;color:#2e7d4f">整天全選</a></div>';
      lastDate = b.date;
    }
    html += '<label style="display:block;cursor:pointer;padding:2px 0"><input type="checkbox" class="mk-b" value="' + esc(b.id) + '" data-no="' + esc(b.no) + '" data-date="' + esc(b.date) + '"> ' + esc(b.no) + '　<span style="color:#888">' + esc(b.time) + ' ' + esc(b.status) + '</span></label>';
  });
  html += '<label style="display:block;margin-top:8px;font-size:13px"><input type="checkbox" id="mk-autoalloc" checked> 先自動分配還沒分配的車次（1車→A … 6車→F）</label>';
  html += '<label style="display:block;font-size:13px"><input type="checkbox" id="mk-skipcancel" checked> 排除「已取消」訂單</label>';
  html += '<button id="mk-go" style="margin-top:10px;width:100%;padding:10px;background:#2e7d4f;color:#fff;border:0;border-radius:6px;font-size:15px;cursor:pointer">產生出貨單（依車號排序）</button>';
  body.innerHTML = html;
  [].forEach.call(panel.querySelectorAll('.mk-day'), function (a) {
    a.onclick = function (e) {
      e.preventDefault();
      var boxes = [].filter.call(panel.querySelectorAll('.mk-b'), function (c) { return c.getAttribute('data-date') === a.getAttribute('data-date'); });
      var allOn = boxes.every(function (c) { return c.checked; });
      boxes.forEach(function (c) { c.checked = !allOn; });
      a.textContent = allOn ? '整天全選' : '取消整天';
    };
  });

  /* ---------- 讀一個批次：訂單 ID、客戶、車次、車次分配進度 ---------- */
  async function readBatch(b, skipCancel) {
    var bp = await loadFrame(ORIGIN + '/delivery-batch/edit/' + b.id, stableCounter(function (d) {
      var rows = d.querySelectorAll('table tbody tr');
      if (!rows.length || !rowOrderId(rows[0]) || !/車次分配\s*\d+\s*\/\s*\d+/.test(d.body.innerText)) return 0;
      return rows.length;
    }, 2));
    var d = bp.frame.contentDocument, warns = [];
    var heads = [].slice.call(d.querySelectorAll('table thead th')).map(txt);
    var iCar = heads.findIndex(function (h) { return h.indexOf('車次') >= 0; });
    var iName = heads.findIndex(function (h) { return h.indexOf('客戶名稱') >= 0; });
    var iState = heads.findIndex(function (h) { return h.indexOf('訂單狀態') >= 0; });
    var iNo = heads.findIndex(function (h) { return h.indexOf('訂單編號') >= 0; });
    var bodyText = d.body.innerText;
    var pageInfo = (/共\s*(\d+)\s*頁/.exec(bodyText) || [])[1];
    if (pageInfo && +pageInfo > 1) warns.push('批次 ' + b.no + ' 有 ' + pageInfo + ' 頁，只抓到第 1 頁（請把「每頁顯示筆數」調大）');
    var am = /車次分配\s*(\d+)\s*\/\s*(\d+)/.exec(bodyText);
    var orders = [];
    d.querySelectorAll('table tbody tr').forEach(function (tr) {
      var tds = tr.children, id = rowOrderId(tr);
      if (!id) return;
      var state = iState >= 0 ? txt(tds[iState]) : '';
      if (skipCancel && /取消/.test(state)) return;
      orders.push({
        id: id, batch: b.no,
        orderNo: iNo >= 0 ? txt(tds[iNo]) : '',
        name: iName >= 0 ? (tds[iName].innerText || '').split('\n')[0].trim() : '',
        car: iCar >= 0 ? txt(tds[iCar]) : ''
      });
    });
    bp.frame.remove();
    return { orders: orders, warns: warns, alloc: am ? { done: +am[1], total: +am[2] } : null };
  }

  /* ---------- 一個批次的完整流程：(分配車次) → 讀訂單 → 載入出貨明細 ---------- */
  async function processBatch(b, opts, prog) {
    prog(b, '讀取訂單…');
    var r = await readBatch(b, opts.skipCancel);
    var res = { b: b, warns: r.warns, allocLog: null, secs: [], css: null, chain: null };
    if (opts.autoAlloc && r.alloc && r.alloc.done < r.alloc.total) {
      prog(b, '分配車次中（' + r.alloc.done + '/' + r.alloc.total + ' 已分配）…');
      var a = await allocRun(b);
      res.allocLog = a.log;
      if (a.changed) { prog(b, '重新讀取車次…'); r = await readBatch(b, opts.skipCancel); }
    }
    var orders = r.orders;
    if (!orders.length) { res.warns.push('批次 ' + b.no + ' 沒有可列印的訂單'); return res; }
    var noCar = orders.filter(function (o) { return carKey(o.car).letter === '~'; });
    if (noCar.length) res.warns.push('批次 ' + b.no + ' 有 ' + noCar.length + ' 張沒有車次（排在最後）：' + noCar.map(function (o) { return o.name; }).join('、'));

    prog(b, '載入出貨明細（' + orders.length + ' 張）…');
    var ids = orders.map(function (o) { return o.id; });
    var fallback = stableCounter(function (dd) { return dd.querySelectorAll('.product-section').length; }, 5);
    var pp = await loadFrame(ORIGIN + '/delivery-batch/edit/' + b.id + '/picking-detail?orderIds=' + ids.join(','), function (dd) {
      var n = dd.querySelectorAll('.product-section').length;
      return n >= ids.length ? n : fallback(dd);
    }, 60000);
    var pd = pp.frame.contentDocument;
    await sleep(150);
    var secs = [].slice.call(pd.querySelectorAll('.product-section'));
    if (secs.length !== orders.length) res.warns.push('批次 ' + b.no + '：訂單 ' + orders.length + ' 筆，但出貨明細只有 ' + secs.length + ' 張，請核對');
    var css = '';
    [].forEach.call(pd.styleSheets, function (s) {
      try { [].forEach.call(s.cssRules, function (rr) { css += rr.cssText + '\n'; }); }
      catch (e) { if (s.href) css += '@import url("' + s.href + '");\n'; }
    });
    var chain = [];
    var p = secs[0] && secs[0].parentElement;
    while (p && p !== pd.body) { chain.unshift({ tag: p.tagName.toLowerCase(), cls: p.className || '', style: p.getAttribute('style') || '' }); p = p.parentElement; }
    chain.bodyCls = pd.body.className; chain.htmlCls = pd.documentElement.className;
    res.css = css; res.chain = secs.length ? chain : null;
    secs.forEach(function (sec, i) {
      var o = orders[i];
      if (!o) return;
      if (o.name && sec.innerText.indexOf(o.name) < 0) res.warns.push('對應可能有誤：' + o.name + '（' + o.orderNo + '）');
      o.noPrice = isNoPrice(o.name);
      var c = sec.cloneNode(true);
      try { customize(c, o.noPrice); } catch (e) { res.warns.push('版面調整失敗（' + o.name + '）：' + e.message); c = sec; }
      res.secs.push({ html: c.outerHTML, o: o, k: carKey(o.car) });
    });
    pp.frame.remove();
    return res;
  }

  panel.querySelector('#mk-go').onclick = async function () {
    var picked = [].slice.call(panel.querySelectorAll('.mk-b:checked')).map(function (c) { return { id: c.value, no: c.getAttribute('data-no') }; });
    if (!picked.length) { status('請先勾選要列印的批次'); return; }
    var opts = { skipCancel: panel.querySelector('#mk-skipcancel').checked, autoAlloc: panel.querySelector('#mk-autoalloc').checked };
    this.disabled = true; this.style.opacity = .6;
    var T0 = Date.now();
    var win = window.open('', '_blank');
    if (win) win.document.write('<meta charset="utf-8"><title>處理中…</title><p style="font:16px sans-serif;padding:20px">正在整理出貨單，請稍候…（請勿關閉後台分頁）</p>');

    /* 所有批次同時處理（以前是一個一個來） */
    var progress = {};
    function prog(b, s) {
      progress[b.no] = s;
      status(picked.map(function (p) { return p.no + '：' + (progress[p.no] || '等待中…'); }).join('\n'));
    }
    var results;
    try {
      results = await Promise.all(picked.map(function (b) {
        return processBatch(b, opts, prog).then(function (r) { prog(b, '完成'); return r; },
          function (e) { prog(b, '失敗：' + e.message); return { b: b, warns: ['批次 ' + b.no + ' 發生錯誤：' + e.message], secs: [] }; });
      }));
    } catch (e) {
      status('發生錯誤：' + e.message);
      if (win) win.document.body.innerHTML = '<p style="font:16px sans-serif;padding:20px;color:#c00">發生錯誤：' + esc(e.message) + '</p>';
      this.disabled = false; this.style.opacity = 1;
      return;
    }
    var cssText = null, wrapperChain = null, sections = [], warns = [], allocNotes = [];
    results.forEach(function (r) {
      if (r.allocLog && r.allocLog.length) allocNotes.push(r.b.no + '：' + r.allocLog.join('；'));
      warns = warns.concat(r.warns || []);
      if (cssText === null && r.css !== null && r.chain) { cssText = r.css; wrapperChain = r.chain; }
      (r.secs || []).forEach(function (s) { s.seq = sections.length; sections.push(s); });
    });
    if (cssText === null) cssText = '';
    cssText += '\n' + MK_CSS;

    if (!sections.length) { status('沒有可列印的訂單。\n' + warns.join('\n')); if (win) win.close(); this.disabled = false; this.style.opacity = 1; return; }

    /* 3) 依車號排序：A 車 → B 車 …，沒有車次的排最後。
          同一台車裡，同一位客人（不同批次）的訂單排在一起，
          客人之間的先後用他在這台車最前面的車次號碼決定。 */
    var cust = function (s) { return String(s.o.name || '').replace(/\s+/g, '') || ('#' + s.seq); };
    var grp = {};
    sections.forEach(function (s) {
      var g = s.k.letter + '|' + cust(s);
      var cur = grp[g];
      if (!cur || s.k.num < cur.num || (s.k.num === cur.num && s.seq < cur.seq)) grp[g] = { num: s.k.num, seq: s.seq };
    });
    sections.sort(function (a, b) {
      if (a.k.letter !== b.k.letter) return a.k.letter < b.k.letter ? -1 : 1;
      var ga = grp[a.k.letter + '|' + cust(a)], gb = grp[b.k.letter + '|' + cust(b)];
      if (ga !== gb) { if (ga.num !== gb.num) return ga.num - gb.num; return ga.seq - gb.seq; }
      if (a.k.num !== b.k.num) return a.k.num - b.k.num;
      return a.seq - b.seq;
    });
    var nCust = Object.keys(grp).length;

    var counts = {};
    sections.forEach(function (s) { var L = s.k.letter === '~' ? '未分車' : s.k.letter + ' 車'; counts[L] = (counts[L] || 0) + 1; });
    var summary = Object.keys(counts).map(function (k) { return '<b>' + k + '</b> ' + counts[k] + ' 張'; }).join('　');
    var nOrders = sections.length;

    var open = '', close = '';
    (wrapperChain || [{ tag: 'div', cls: 'container', style: '' }]).forEach(function (w) {
      open += '<' + w.tag + ' class="' + esc(w.cls) + '"' + (w.style ? ' style="' + esc(w.style) + '"' : '') + '>';
      close = '</' + w.tag + '>' + close;
    });

    /* 4) 長訂單切頁，每頁都有抬頭 */
    status('檢查品項較多、需要兩頁以上的訂單…');
    try { sections = await paginate(sections, cssText, open, close, wrapperChain && wrapperChain.bodyCls); }
    catch (e) { warns.push('分頁檢查失敗（' + e.message + '），長訂單第 2 頁可能沒有抬頭'); }
    sections.forEach(function (s) { try { s.html = placeNote(s.html); } catch (e) {} });
    var noPriceNames = sections.filter(function (s) { return s.o.noPrice && (!s.page || s.page === 1); }).map(function (s) { return s.k.label + ' ' + s.o.name; });
    var multi = sections.filter(function (s) { return s.page === 1 && s.pages > 1; });
    var nPages = sections.length;

    var listRows = sections.filter(function (s) { return !s.page || s.page === 1; }).map(function (s, i) {
      return '<tr><td>' + (i + 1) + '</td><td><b>' + esc(s.k.label) + '</b></td><td>' + esc(s.o.name) + (s.pages > 1 ? ' <b>（' + s.pages + ' 頁）</b>' : '') + '</td><td>' + esc(s.o.orderNo) + '</td><td>' + esc(s.o.batch) + '</td></tr>';
    }).join('');
    var title = '出貨明細_依車號_' + picked.map(function (p) { return p.no; }).join('_');
    var out = '<!doctype html><html class="' + esc((wrapperChain && wrapperChain.htmlCls) || '') + '"><head><meta charset="utf-8"><base href="' + ORIGIN + '/"><title>' + esc(title) + '</title>'
      + '<style>' + cssText + '</style>'
      + '<style>.mk-toolbar{font:14px/1.6 "Microsoft JhengHei",sans-serif;background:#f3faf5;border:1px solid #b9dcc5;border-radius:8px;padding:12px 16px;margin:12px auto;max-width:900px}'
      + '.mk-toolbar button{background:#2e7d4f;color:#fff;border:0;border-radius:6px;padding:8px 22px;font-size:16px;cursor:pointer;margin-right:10px}'
      + '.mk-toolbar table{border-collapse:collapse;margin-top:8px;width:100%;font-size:13px}.mk-toolbar td{border-top:1px solid #dde;padding:2px 6px}'
      + '.mk-warn{color:#b00020;white-space:pre-line;margin-top:6px}@media print{.mk-toolbar{display:none!important}}</style>'
      + '</head><body class="' + esc((wrapperChain && wrapperChain.bodyCls) || '') + '">'
      + '<div class="mk-toolbar"><button onclick="window.print()">列印</button>共 <b>' + nCust + '</b> 位客戶、<b>' + nOrders + '</b> 張訂單、<b>' + nPages + '</b> 頁，已依車號排序（同車同客人排在一起）：' + summary
      + (multi.length ? '<div style="margin-top:4px">品項較多、印成多頁的：' + multi.map(function (s) { return esc(s.k.label + ' ' + s.o.name) + '（' + s.pages + ' 頁）'; }).join('、') + '，每頁都有抬頭和「第 X/Y 頁」。</div>' : '')
      + (noPriceNames.length ? '<div style="margin-top:4px">預算制、<b>不印價格</b>的：' + esc(noPriceNames.join('、')) + '</div>' : '')
      + (allocNotes.length ? '<div style="margin-top:4px;color:#8a5a00">自動分配車次：' + esc(allocNotes.join('　')) + '</div>' : '')
      + (warns.length ? '<div class="mk-warn">⚠ ' + esc(warns.join('\n⚠ ')) + '</div>' : '')
      + '<details><summary style="cursor:pointer;margin-top:6px">查看列印順序</summary><table><tr><td>#</td><td>車次</td><td>客戶</td><td>訂單編號</td><td>批次</td></tr>' + listRows + '</table></details>'
      + '<div style="font-size:12px;color:#888;margin-top:4px">（這個綠色區塊不會被印出來）</div></div>'
      + open + sections.map(function (s) { return s.html; }).join('') + close
      + '</body></html>';

    if (win && !win.closed) {
      win.document.open(); win.document.write(out); win.document.close();
      status('完成！共 ' + nCust + ' 位客戶、' + nOrders + ' 張訂單、' + nPages + ' 頁，已在新分頁開啟（用時 ' + Math.round((Date.now() - T0) / 1000) + ' 秒）。' + (allocNotes.length ? '\n自動分配車次：' + allocNotes.join('；') : '') + (warns.length ? '\n⚠ ' + warns.join('\n⚠ ') : ''));
    } else {
      status('瀏覽器擋住了新分頁，改在目前頁面顯示（列印完按「上一頁」回後台）。');
      document.open(); document.write(out); document.close();
    }
    this.disabled = false; this.style.opacity = 1;
  };

  /* ================= 自動分配車次：1車→A、2車→B … 6車→F =================
   * 用後台自己的「車次分配」頁面操作（隱藏視窗），只處理「未分配車次列表」裡的訂單，
   * 已經分配好的訂單完全不動。缺少的車次會用後台的「新增車次」補上。 */
  var LETTERS = 'ABCDEF';
  function leaf(doc, t) {
    return [].find.call(doc.querySelectorAll('body *'), function (e) { return !e.children.length && e.textContent.trim() === t; });
  }
  function btn(doc, t) {
    return [].find.call(doc.querySelectorAll('button'), function (b) { return b.innerText.replace(/\s+/g, '') === t; });
  }
  async function waitFor(fn, timeout, step) {
    var t0 = Date.now();
    while (Date.now() - t0 < (timeout || 15000)) {
      var r = null; try { r = fn(); } catch (e) { r = null; }
      if (r) return r;
      await sleep(step || 200);
    }
    return null;
  }
  /* 「以車次顯示」：目前有哪些車次 */
  function readVehicles(doc) {
    if (!btn(doc, '新增車次')) return null;
    var table = doc.querySelector('table'); if (!table) return null;
    return [].map.call(table.querySelectorAll('tbody tr'), function (tr) { return txt(tr.children[0]); }).filter(Boolean);
  }
  /* 「以訂單顯示」：未分配的訂單（第一欄是勾選框，配送路線例如「2車」） */
  function readUnalloc(doc) {
    var h = leaf(doc, '未分配車次列表');
    if (!h || !leaf(doc, '已分配車次列表')) return null;
    var box = h.parentElement.parentElement.parentElement;
    if (getComputedStyle(box).display === 'none') return [];
    var ths = [].map.call(box.querySelectorAll('thead th'), txt);
    var iRoute = ths.findIndex(function (x) { return x.indexOf('配送路線') >= 0; });
    var iName = ths.findIndex(function (x) { return x.indexOf('客戶名稱') >= 0; });
    var out = [];
    box.querySelectorAll('tbody tr').forEach(function (tr) {
      var tds = tr.children;
      var cb = tds[0] && tds[0].querySelector('input[type=checkbox]');
      if (!cb) return;
      var route = iRoute >= 0 && tds[iRoute] ? txt(tds[iRoute]) : '';
      var m = /(\d+)\s*車/.exec(route);
      var n = m ? parseInt(m[1], 10) : 0;
      out.push({ cb: cb, route: route || '-', n: n, letter: n >= 1 && n <= LETTERS.length ? LETTERS[n - 1] : '', name: iName >= 0 && tds[iName] ? txt(tds[iName]) : '' });
    });
    return out;
  }
  function stable(fn, times) {
    var last = null, same = 0;
    return function () {
      var r = fn();
      var key = r ? JSON.stringify(r.map(function (x) { return typeof x === 'string' ? x : x.route + '|' + x.name + '|' + x.cb.checked; })) : null;
      if (r && key === last) same++; else same = 0;
      last = key;
      return same >= (times || 2) ? r : null;
    };
  }
  async function showVehicles(doc) {
    var b = btn(doc, '以車次顯示'); if (b) b.click();
    var v = await waitFor(stable(function () { return readVehicles(doc); }, 2), 20000);
    if (!v) throw new Error('「以車次顯示」載入逾時');
    return v;
  }
  async function showOrders(doc) {
    var b = btn(doc, '以訂單顯示'); if (!b) throw new Error('找不到「以訂單顯示」');
    b.click();
    var r = await waitFor(stable(function () { return readUnalloc(doc); }, 3), 20000);
    if (!r) throw new Error('「以訂單顯示」載入逾時');
    return r;
  }

  async function allocRun(b) {
    var log = [], changed = false;
    var f = await loadFrame(ORIGIN + '/delivery-batch/edit/' + b.id + '?pageType=vehicle', function (d) { return readVehicles(d) ? 1 : 0; }, 40000);
    var doc = f.frame.contentDocument;
    try {
      var vehicles = await showVehicles(doc);
      var rows = await showOrders(doc);
      var todo = rows.filter(function (r) { return r.letter && !r.cb.disabled; });
      var need = LETTERS.split('').filter(function (L) { return todo.some(function (r) { return r.letter === L; }); });
      var missing = need.filter(function (L) { return vehicles.indexOf(L) < 0; });

      /* 1) 缺車次就新增（後台會自動取下一個字母，例如 E、F） */
      if (missing.length) {
        vehicles = await showVehicles(doc);
        var addedNames = [];
        for (var guard = 0; guard < 6 && need.some(function (L) { return vehicles.indexOf(L) < 0; }); guard++) {
          var before = vehicles.length;
          btn(doc, '新增車次').click();
          var v = await waitFor(function () { var x = readVehicles(doc); return x && x.length > before ? x : null; }, 12000);
          if (!v) { log.push('⚠ 新增車次沒有反應'); break; }
          await sleep(300);
          var now = readVehicles(doc) || v;
          now.forEach(function (x) { if (vehicles.indexOf(x) < 0) addedNames.push(x); });
          vehicles = now;
          changed = true;
        }
        if (addedNames.length) log.push('新增車次 ' + addedNames.join('、'));
        rows = await showOrders(doc);
      }

      /* 2) 依配送路線分到對應車次 */
      for (var n = 1; n <= LETTERS.length; n++) {
        var L = LETTERS[n - 1];
        rows = readUnalloc(doc) || [];
        var mine = rows.filter(function (r) { return r.n === n && !r.cb.disabled; });
        if (!mine.length) continue;
        if (vehicles.indexOf(L) < 0) { log.push('⚠ 沒有車次 ' + L + '，' + n + '車 ' + mine.length + ' 筆沒分配'); continue; }
        rows.forEach(function (r) { if (r.cb.checked && r.n !== n) r.cb.click(); });
        mine.forEach(function (r) { if (!r.cb.checked) r.cb.click(); });
        var ab = await waitFor(function () {
          var sel = (/已選訂單：\s*(\d+)/.exec(doc.body.innerText) || [])[1];
          return +sel === mine.length && btn(doc, '分配車次');
        }, 6000);
        if (!ab) { log.push('⚠ ' + n + '車 勾選失敗，沒分配'); continue; }
        ab.click();
        var item = await waitFor(function () {
          return [].find.call(doc.querySelectorAll('li[role="menuitem"], .MuiMenuItem-root'), function (li) { return txt(li) === L; });
        }, 8000);
        if (!item) { log.push('⚠ 選單裡沒有車次 ' + L + '（' + n + '車）'); continue; }
        if (item.getAttribute('aria-disabled') === 'true' || item.classList.contains('Mui-disabled')) {
          log.push('⚠ 車次 ' + L + ' 已出貨，' + n + '車 ' + mine.length + ' 筆沒分配');
          var bd = doc.querySelector('.MuiBackdrop-root, .MuiPopover-root > div[aria-hidden]'); if (bd) bd.click();
          mine.forEach(function (r) { if (r.cb.checked) r.cb.click(); });
          await sleep(300);
          continue;
        }
        item.click();
        var ok = await waitFor(function () {
          var r = readUnalloc(doc); return r && !r.some(function (x) { return x.n === n && !x.cb.disabled; }) ? 1 : null;
        }, 20000);
        if (ok) { changed = true; log.push(n + '車→' + L + ' ' + mine.length + ' 筆'); }
        else log.push('⚠ ' + n + '車→' + L + ' 分配後沒看到更新，請到後台確認');
        await waitFor(stable(function () { return readUnalloc(doc); }, 2), 5000);
      }
      var left = (readUnalloc(doc) || []).filter(function (r) { return !r.cb.disabled; });
      if (left.length) log.push('⚠ 還有 ' + left.length + ' 筆沒分配（配送路線：' + left.map(function (r) { return r.route; }).filter(function (x, i, a) { return a.indexOf(x) === i; }).join('、') + '），請手動分配');
    } finally {
      f.frame.remove();
    }
    return { log: log, changed: changed };
  }
})();
