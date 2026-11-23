/* 馬可小幫手：檢查待接單（半自動接單）
 * 1. 找出「期望配送日期」= 指定日期、狀態「待審核」的自有訂單
 * 2. 逐筆讀「下單備註」與商品下方的「商品備註」，對照 Google 試算表的「常態 OK 清單」（主管核准的才算）
 * 3. 沒備註／備註都已核准 → 綠色預先勾選；其他 → 紅色，直接顯示備註內容
 * 4. 小姐看完 LINE 群，取消有交代的，再按「接單」。接單前每筆會重新檢查一次。
 * 只操作後台自己的頁面（隱藏 iframe），不會改訂單內容。
 */
(async function () {
  if (!/super-marco\.com$/.test(location.hostname)) {
    alert('請在馬可供應商後台（supply-admin.super-marco.com）的頁面上使用。');
    return;
  }
  var OK_API = 'https://script.google.com/macros/s/AKfycbxQK0BUWNmiNjh5sbU77y8X0YnerMfF7eakGQMjZJQxwsZBcw0Lh0QTDHjBognWIikpew/exec';
  var SHEET_URL = 'https://docs.google.com/spreadsheets/d/17vD0XABzHYb6wLdZcL94xV4zEflM8MF7v4yyhJ7cc5o/edit';
  var STATUS_RE = /^(待審核|已接單|揀貨完成|配送中|已送達|已取消)$/;
  var PAR = 4;

  var old = document.getElementById('mk-accept');
  if (old) old.remove();

  /* ---------- 小工具 ---------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function lines(s) { return String(s || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean); }
  function norm(s) {
    return String(s || '').replace(/[\s　]/g, '')
      .replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); })
      .replace(/[×xX*]/g, '*').toLowerCase();
  }
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function defaultDate() {
    var d = new Date();
    if (d.getHours() >= 6) d.setDate(d.getDate() + 1); // 早上 6 點後做的都是明天的單；凌晨 0～6 點還算今天
    return ymd(d);
  }
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
  function openFrame(url) {
    var f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:-12000px;top:0;width:1400px;height:1000px;visibility:hidden;';
    f.src = url;
    document.body.appendChild(f);
    return f;
  }
  function rowId(tr) {
    var k = Object.keys(tr).find(function (k) { return k.indexOf('__reactFiber') === 0; });
    var f = k && tr[k];
    for (var i = 0; i < 8 && f; i++) {
      if (f.key != null && /\d{3,}/.test(String(f.key))) return String(f.key).replace(/\D/g, '');
      f = f.return;
    }
    return null;
  }

  /* ---------- 讀「待審核」列表 ---------- */
  async function readPendingList(setStatus) {
    var f = openFrame('/order/own');
    try {
      var doc;
      var tab = await waitFor(function () {
        doc = f.contentDocument;
        return [].find.call(doc.querySelectorAll('button,[role=tab]'), function (b) { return /^待審核\(\d+\)$/.test(b.innerText.replace(/\s+/g, '')); });
      }, 30000);
      if (!tab) throw new Error('打不開「自有訂單」頁面');
      // 後台會記住上次的篩選條件（例如某個客戶），先清除，才不會漏單
      var clr = btn(doc, '清除');
      if (clr && !clr.disabled) {
        setStatus('清除後台記住的篩選條件…');
        clr.click();
        await sleep(600);
        f.contentWindow.location.reload();
        await sleep(500);
        tab = await waitFor(function () {
          doc = f.contentDocument;
          return [].find.call(doc.querySelectorAll('button,[role=tab]'), function (b) { return /^待審核\(\d+\)$/.test(b.innerText.replace(/\s+/g, '')); });
        }, 30000);
        await sleep(800);
        clr = btn(doc, '清除');
        if (!tab || (clr && !clr.disabled)) throw new Error('後台還有篩選條件清不掉，請到「自有訂單」按「清除」後再試一次');
      }
      tab.click();
      await sleep(300);
      // 等「全部(N)」載入完成（N>0），而且待審核筆數連續幾次都一樣，才算讀到正確數字
      var total = -1, lastT = -2, sameT = 0;
      await waitFor(function () {
        var tabs = [].map.call(doc.querySelectorAll('button,[role=tab]'), function (b) { return b.innerText.replace(/\s+/g, ''); });
        var all = tabs.find(function (s) { return /^全部\(\d+\)$/.test(s); });
        var pend = tabs.find(function (s) { return /^待審核\(\d+\)$/.test(s); });
        if (!all || !pend || !(parseInt(all.replace(/\D/g, ''), 10) > 0)) { sameT = 0; return false; }
        total = parseInt(pend.replace(/\D/g, ''), 10);
        if (total === lastT) sameT++; else sameT = 0;
        lastT = total;
        var t = [].find.call(doc.querySelectorAll('button,[role=tab]'), function (b) { return /^待審核\(\d+\)$/.test(b.innerText.replace(/\s+/g, '')); });
        return sameT >= 4 && (t.getAttribute('aria-selected') === 'true' || /Mui-selected/.test(t.className));
      }, 15000, 250);
      if (total < 0) throw new Error('讀不到待審核筆數');
      if (!total) return [];
      // 每頁 100 筆
      var psLab = [].find.call(doc.querySelectorAll('p'), function (e) { return /每頁顯示筆數/.test(e.textContent); });
      var ps = psLab && psLab.parentElement.querySelector('[role=button]');
      if (ps && ps.innerText.trim() !== '100') {
        ps.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        ps.click();
        ps.click();
        var opt = await waitFor(function () { return [].find.call(doc.querySelectorAll('li,[role=option]'), function (o) { return o.textContent.trim() === '100'; }); }, 4000);
        if (opt) {
          opt.click();
          var want = Math.min(total, 100);
          await waitFor(function () { return doc.querySelectorAll('table tbody tr').length >= want; }, 8000, 250);
        }
      }
      var out = {}, page = 1;
      while (true) {
        setStatus('讀取待審核訂單…（' + Object.keys(out).length + '/' + total + '）');
        var last = '', same = 0;
        await waitFor(function () {
          var rows = [].slice.call(doc.querySelectorAll('table tbody tr'));
          var okRows = rows.filter(function (tr) { return /待審核/.test(tr.innerText) && rowId(tr); });
          var sig = okRows.map(rowId).join(',');
          if (okRows.length && okRows.length === rows.length && sig === last) same++; else same = 0;
          last = sig;
          return same >= 2;
        }, 15000, 250);
        [].forEach.call(doc.querySelectorAll('table tbody tr'), function (tr) {
          var id = rowId(tr); if (!id || !/待審核/.test(tr.innerText)) return;
          // 第一欄：客戶名稱／採購單位／訂單編號；第一個日期就是「期望配送時間」
          var cell = [].find.call(tr.querySelectorAll('td'), function (td) { return /\d{8,}/.test(td.innerText); });
          var c = lines(cell && cell.innerText);
          var dm = /(\d{4}-\d{2}-\d{2})/.exec(tr.innerText);
          out[id] = { id: id, customer: c[0] || '', unit: c[1] || '', no: c[2] || '', date: dm ? dm[1] : '' };
        });
        if (Object.keys(out).length >= total) break;
        var next = [].find.call(doc.querySelectorAll('button'), function (b) { return /下一頁|next page/i.test(b.getAttribute('aria-label') || '') && !b.disabled; });
        if (!next || page > 20) break;
        next.click(); page++;
        await sleep(500);
      }
      return Object.keys(out).map(function (k) { return out[k]; });
    } finally { f.remove(); }
  }

  /* ---------- 讀訂單詳情：狀態、客戶、下單備註、商品備註 ---------- */
  function parseDetail(doc) {
    var t = doc.body.innerText;
    var i = t.lastIndexOf('訂單詳情');
    if (i < 0 || t.indexOf('配送方式', i) < 0) return null;
    var lab = leaf(doc, '下單備註'); if (!lab) return null;
    var rows = doc.querySelectorAll('table tbody tr'); if (!rows.length) return null;
    var head = lines(t.slice(i, t.indexOf('配送方式', i)));
    var si = head.findIndex(function (s) { return STATUS_RE.test(s); });
    if (si < 1) return null;
    var custLine = head[si - 1], cut = custLine.lastIndexOf('/');
    var row = lab.parentElement;
    var noteEl = row.children[row.children.length - 1];
    var orderNote = noteEl === lab ? '' : noteEl.innerText.trim();
    if (orderNote === '無') orderNote = '';
    var products = [], notes = [];
    [].forEach.call(rows, function (tr) {
      var tds = tr.querySelectorAll('td');
      if (tds.length === 1) { // 商品下方的灰色列 = 商品備註
        var n = tr.innerText.trim();
        if (n && products.length) notes.push({ product: products[products.length - 1], note: n });
      } else if (tds.length > 1) {
        var p = tds[0].querySelector('p');
        products.push(((p && p.innerText) || lines(tds[0].innerText)[0] || '').trim());
      }
    });
    if (orderNote) notes.unshift({ product: '（下單備註）', note: orderNote });
    var dm = /期望配送時間\s*\n?\s*(\d{4}-\d{2}-\d{2})/.exec(t);
    var nm = /訂單詳情\s*(\d{8,})/.exec(t);
    return {
      status: head[si],
      customer: cut > 0 ? custLine.slice(0, cut) : custLine,
      unit: cut > 0 ? custLine.slice(cut + 1) : '',
      date: dm ? dm[1] : '',
      no: nm ? nm[1] : '',
      nProducts: products.length,
      notes: notes
    };
  }
  function noteSig(d) { return JSON.stringify(d.notes.map(function (n) { return [n.product, n.note]; })); }

  async function readDetail(id, keepFrame) {
    var f = openFrame('/order/detail/' + id);
    var last = '', same = 0, res = null;
    res = await waitFor(function () {
      var d = parseDetail(f.contentDocument);
      if (!d) { same = 0; return null; }
      var sig = d.status + '|' + d.nProducts + '|' + noteSig(d);
      if (sig === last) same++; else same = 0;
      last = sig;
      return same >= 2 ? d : null;
    }, 30000, 200);
    if (!keepFrame) { f.remove(); return res; }
    return { d: res, frame: f };
  }

  async function pool(items, n, fn) {
    var i = 0, out = new Array(items.length);
    async function worker() { while (i < items.length) { var k = i++; out[k] = await fn(items[k], k); } }
    var ws = []; for (var j = 0; j < Math.min(n, items.length); j++) ws.push(worker());
    await Promise.all(ws);
    return out;
  }

  /* ---------- 常態 OK 清單 ---------- */
  var okList = [];
  async function loadOkList() {
    var r = await fetch(OK_API + '?action=list&t=' + Date.now());
    var j = await r.json();
    if (!j.ok) throw new Error('讀不到常態 OK 清單');
    okList = j.list || [];
  }
  function matchNote(customer, n) {
    var c = norm(customer), p = norm(n.product), t = norm(n.note);
    var hit = null;
    okList.forEach(function (x) {
      if (norm(x.note) !== t || norm(x.product) !== p) return;
      if (x.scope !== '所有客戶' && norm(x.customer) !== c) return;
      if (!hit || (hit.status !== '核准' && x.status === '核准')) hit = x;
    });
    return hit ? hit.status : '';
  }
  /* 名稱相似（改名或連鎖分店）的提醒，只提醒、不自動套用 */
  function similarHint(customer, n) {
    var c = norm(customer), p = norm(n.product), t = norm(n.note);
    var cand = okList.filter(function (x) {
      if (x.status !== '核准' || x.scope === '所有客戶') return false;
      if (norm(x.note) !== t || norm(x.product) !== p) return false;
      var y = norm(x.customer);
      if (!y || y === c) return false;
      return y.indexOf(c) >= 0 || c.indexOf(y) >= 0 || (y.slice(0, 2) === c.slice(0, 2));
    });
    return cand.length ? cand[0].customer : '';
  }

  /* ---------- 介面 ---------- */
  var box = document.createElement('div');
  box.id = 'mk-accept';
  box.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.35);display:flex;align-items:flex-start;justify-content:center;padding:24px 12px;font:14px/1.5 "Microsoft JhengHei",sans-serif;color:#222;';
  box.innerHTML =
    '<div id="mk-ac-card" style="background:#fff;border:2px solid #2e7d4f;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.3);width:min(1000px,100%);max-height:calc(100vh - 48px);display:flex;flex-direction:column;">' +
    '<div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #e3e3e3;flex-wrap:wrap;">' +
    '<b style="font-size:17px;color:#2e7d4f;">📋 檢查待接單</b>' +
    '<label>期望配送日期 <input id="mk-ac-date" type="date" style="font:inherit;padding:2px 4px;"></label>' +
    '<button id="mk-ac-run" style="font:inherit;padding:4px 12px;background:#2e7d4f;color:#fff;border:0;border-radius:6px;cursor:pointer;">重新檢查</button>' +
    '<a href="' + SHEET_URL + '" target="_blank" style="color:#2e7d4f;">常態 OK 清單</a>' +
    '<span style="flex:1"></span><button id="mk-ac-close" style="font:inherit;border:0;background:none;font-size:20px;cursor:pointer;" title="關閉">✕</button></div>' +
    '<div id="mk-ac-status" style="padding:8px 16px;color:#555;"></div>' +
    '<div id="mk-ac-body" style="overflow:auto;padding:0 16px 8px;flex:1;"></div>' +
    '<div id="mk-ac-foot" style="padding:10px 16px;border-top:1px solid #e3e3e3;display:none;align-items:center;gap:10px;flex-wrap:wrap;"></div>' +
    '</div>';
  document.body.appendChild(box);
  var $ = function (id) { return document.getElementById(id); };
  $('mk-ac-date').value = defaultDate();
  $('mk-ac-close').onclick = function () { box.remove(); };
  function setStatus(s) { $('mk-ac-status').innerHTML = s; }

  var orders = [];
  var busy = false;

  function chip(st) {
    if (st === '核准') return '<span style="background:#d9f2d9;color:#1b5e20;border-radius:4px;padding:0 6px;">✓ 常態OK</span>';
    if (st === '待審核') return '<span style="background:#fff4cc;color:#8a6d00;border-radius:4px;padding:0 6px;">⏳ 送審中</span>';
    return '<span style="background:#fde2e1;color:#b71c1c;border-radius:4px;padding:0 6px;">✗ 未核准</span>';
  }

  function render() {
    var green = orders.filter(function (o) { return o.ok; }), red = orders.filter(function (o) { return !o.ok; });
    function rowHtml(o) {
      var notes = o.d.notes.map(function (n, k) {
        var st = matchNote(o.d.customer, n);
        var hint = st ? '' : similarHint(o.d.customer, n);
        return '<div style="margin:2px 0;">' + chip(st) + ' <b>' + esc(n.product) + '</b>：' + esc(n.note) +
          (st ? '' : ' <button class="mk-ac-sub" data-o="' + o.id + '" data-k="' + k + '" style="font:12px inherit;padding:0 6px;cursor:pointer;">送審成常態OK</button>') +
          (hint ? '<div style="color:#b26a00;font-size:12px;">⚠ 清單上「' + esc(hint) + '」有同樣的 OK 備註。如果是同一家（改名或分店），請送審。</div>' : '') +
          '</div>';
      }).join('');
      var res = o.result ? '<div style="font-weight:700;color:' + (o.result.ok ? '#1b5e20' : '#b71c1c') + ';">' + esc(o.result.msg) + '</div>' : '';
      return '<tr style="border-top:1px solid #eee;' + (o.result && o.result.ok ? 'opacity:.55;' : '') + '">' +
        '<td style="padding:6px 4px;vertical-align:top;"><input type="checkbox" class="mk-ac-cb" data-o="' + o.id + '"' + (o.checked ? ' checked' : '') + (o.result && o.result.ok ? ' disabled' : '') + ' style="width:18px;height:18px;"></td>' +
        '<td style="padding:6px 4px;vertical-align:top;word-break:break-all;"><b>' + esc(o.d.customer) + '</b> <button class="mk-ac-copy" data-o="' + o.id + '" title="複製客戶名稱，到 LINE 貼上搜尋" style="font:12px inherit;padding:0 6px;cursor:pointer;white-space:nowrap;">📋 複製</button><div style="color:#888;font-size:12px;">' + esc(o.d.no || o.no) + '</div></td>' +
        '<td style="padding:6px 4px;vertical-align:top;">' + (o.d.notes.length ? notes : '<span style="color:#888;">沒有備註</span>') + res + '</td>' +
        '<td style="padding:6px 4px;vertical-align:top;"><a href="/order/detail/' + o.id + '" target="_blank" style="color:#2e7d4f;">查看</a></td></tr>';
    }
    function table(title, list, color) {
      if (!list.length) return '';
      return '<div style="margin-top:10px;font-weight:700;color:' + color + ';">' + title + '（' + list.length + ' 筆）</div>' +
        '<table style="width:100%;border-collapse:collapse;table-layout:fixed;"><colgroup><col style="width:34px"><col style="width:210px"><col><col style="width:52px"></colgroup>' + list.map(rowHtml).join('') + '</table>';
    }
    $('mk-ac-body').innerHTML = orders.length
      ? '<div style="background:#f3f8f4;border-radius:6px;padding:8px 10px;margin-top:4px;">請照客戶名稱打開 LINE 群組看有沒有新交代：<b>有交代的請取消勾選</b>，自己去改單、手動接單。紅色的備註看過沒問題，也可以自己勾起來。</div>' +
        table('🔴 有備註要看', red, '#b71c1c') + table('🟢 可以直接接單（沒備註或都是常態OK）', green, '#1b5e20')
      : '';
    [].forEach.call(document.querySelectorAll('.mk-ac-cb'), function (cb) {
      cb.onchange = function () { var o = byId(cb.dataset.o); if (o) o.checked = cb.checked; renderFoot(); };
    });
    [].forEach.call(document.querySelectorAll('.mk-ac-copy'), function (b) {
      b.onclick = function () { var o = byId(b.dataset.o); if (o) copyText(o.d.customer, b); };
    });
    [].forEach.call(document.querySelectorAll('.mk-ac-sub'), function (b) {
      b.onclick = function () { openSubmit(byId(b.dataset.o), +b.dataset.k, b); };
    });
    renderFoot();
  }
  /* 複製客戶名稱（給小姐貼到 LINE 搜尋） */
  function copyText(t, b) {
    function done(ok) {
      b.textContent = ok ? '✓ 已複製' : '複製失敗';
      b.style.background = ok ? '#d9f2d9' : '#fde2e1';
      setTimeout(function () { b.textContent = '📋 複製'; b.style.background = ''; }, 1500);
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = t; ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove(); done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { done(true); }, fallback);
    else fallback();
  }
  function byId(id) { return orders.find(function (o) { return o.id === id; }); }

  function renderFoot(confirming) {
    var foot = $('mk-ac-foot');
    var n = orders.filter(function (o) { return o.checked && !(o.result && o.result.ok); }).length;
    if (!orders.length) { foot.style.display = 'none'; return; }
    foot.style.display = 'flex';
    if (confirming && n) {
      foot.innerHTML = '<b style="color:#b71c1c;">確定要接單 ' + n + ' 筆嗎？接單後無法取消。</b>' +
        '<button id="mk-ac-yes" style="font:inherit;padding:6px 16px;background:#b71c1c;color:#fff;border:0;border-radius:6px;cursor:pointer;">確定接單</button>' +
        '<button id="mk-ac-no" style="font:inherit;padding:6px 16px;cursor:pointer;">取消</button>';
      $('mk-ac-yes').onclick = doAccept;
      $('mk-ac-no').onclick = function () { renderFoot(); };
    } else {
      foot.innerHTML = '<span>已勾選 <b>' + n + '</b> 筆</span>' +
        '<button id="mk-ac-go" ' + (n && !busy ? '' : 'disabled ') + 'style="font:inherit;padding:6px 16px;background:#2e7d4f;color:#fff;border:0;border-radius:6px;cursor:pointer;">接單已勾選的訂單</button>';
      $('mk-ac-go').onclick = function () { renderFoot(true); };
    }
  }

  /* ---------- 送審 ---------- */
  function openSubmit(o, k, anchor) {
    var n = o.d.notes[k];
    var who = '';
    try { who = localStorage.getItem('mk-who') || ''; } catch (e) {}
    var div = document.createElement('div');
    div.style.cssText = 'background:#fffbe8;border:1px solid #e6d27a;border-radius:6px;padding:8px;margin:4px 0;';
    div.innerHTML = '送審：<b>' + esc(o.d.customer) + '</b> ／ ' + esc(n.product) + ' ／ ' + esc(n.note) + '<br>' +
      '適用：<label><input type="radio" name="mk-sc" value="此客戶" checked> 只有這個客戶</label> ' +
      '<label><input type="radio" name="mk-sc" value="所有客戶"> 所有客戶</label><br>' +
      '送審人：<input class="mk-who" value="' + esc(who) + '" placeholder="你的名字" style="font:inherit;width:8em;"> ' +
      '<button class="mk-send" style="font:inherit;padding:2px 10px;cursor:pointer;">送出</button> <button class="mk-cancel" style="font:inherit;padding:2px 10px;cursor:pointer;">取消</button>' +
      '<div style="color:#666;font-size:12px;">送出後要等主管在試算表把狀態改成「核准」才會生效。</div>';
    anchor.replaceWith(div);
    div.querySelector('.mk-cancel').onclick = render;
    div.querySelector('.mk-send').onclick = async function () {
      var w = div.querySelector('.mk-who').value.trim();
      if (!w) { alert('請填送審人名字'); return; }
      try { localStorage.setItem('mk-who', w); } catch (e) {}
      var sc = div.querySelector('input[name=mk-sc]:checked').value;
      this.disabled = true; this.textContent = '送出中…';
      try {
        var q = 'action=submit&customer=' + encodeURIComponent(o.d.customer) + '&product=' + encodeURIComponent(n.product) +
          '&note=' + encodeURIComponent(n.note) + '&scope=' + encodeURIComponent(sc) + '&who=' + encodeURIComponent(w);
        var j = await (await fetch(OK_API + '?' + q)).json();
        if (!j.ok) throw new Error(j.msg || '送審失敗');
        okList.push({ status: j.dup ? j.status : '待審核', customer: o.d.customer, product: n.product, note: n.note, scope: sc });
        render();
      } catch (e) { alert('送審失敗：' + e.message); this.disabled = false; this.textContent = '送出'; }
    };
  }

  /* ---------- 檢查 ---------- */
  async function run() {
    if (busy) return;
    busy = true; orders = []; render();
    var date = $('mk-ac-date').value, t0 = Date.now();
    try {
      setStatus('讀取常態 OK 清單…');
      await loadOkList();
      var list = await readPendingList(setStatus);
      var mine = list.filter(function (o) { return o.date === date; });
      var others = list.length - mine.length;
      if (!mine.length) {
        setStatus('期望配送 <b>' + date + '</b> 沒有待審核的訂單。' + (others ? '（其他日期還有 ' + others + ' 筆待審核）' : ''));
        return;
      }
      var done = 0;
      var details = await pool(mine, PAR, async function (o) {
        var d = await readDetail(o.id);
        done++; setStatus('逐筆檢查備註…（' + done + '/' + mine.length + '）');
        return d;
      });
      var fail = [];
      mine.forEach(function (o, k) {
        var d = details[k];
        if (!d) { fail.push(o.customer || o.id); return; }
        if (d.status !== '待審核' || d.date !== date) return;
        o.d = d;
        o.ok = d.notes.every(function (n) { return matchNote(d.customer, n) === '核准'; });
        o.checked = o.ok;
        o.sig = noteSig(d);
        orders.push(o);
      });
      orders.sort(function (a, b) { return a.d.customer.localeCompare(b.d.customer, 'zh-Hant'); });
      var g = orders.filter(function (o) { return o.ok; }).length;
      setStatus('期望配送 <b>' + date + '</b>：待審核 <b>' + orders.length + '</b> 筆（🟢 ' + g + '、🔴 ' + (orders.length - g) + '），用時 ' + Math.round((Date.now() - t0) / 1000) + ' 秒' +
        (others ? '；其他日期還有 ' + others + ' 筆待審核' : '') +
        (fail.length ? '<br><span style="color:#b71c1c;">⚠ 有 ' + fail.length + ' 筆讀不到（' + esc(fail.join('、')) + '），請到後台手動看</span>' : ''));
    } catch (e) {
      setStatus('<span style="color:#b71c1c;">發生錯誤：' + esc(e.message) + '</span>');
    } finally { busy = false; render(); }
  }

  /* ---------- 接單（每筆接單前重新檢查一次） ---------- */
  async function acceptOne(o) {
    var r = await readDetail(o.id, true);
    var f = r.frame, d = r.d;
    try {
      if (!d) return { ok: false, msg: '✗ 讀不到訂單，沒有接單' };
      if (d.status !== '待審核') return { ok: false, msg: '✗ 狀態已經是「' + d.status + '」，沒有接單' };
      if (noteSig(d) !== o.sig) { o.d = d; return { ok: false, msg: '✗ 備註有變動，沒有接單，請重新看過' }; }
      var doc = f.contentDocument;
      var b = btn(doc, '接單');
      if (!b) return { ok: false, msg: '✗ 找不到「接單」按鈕' };
      b.click();
      var clicked = false;
      var res = await waitFor(function () {
        var dd = parseDetail(doc);
        if (dd && dd.status !== '待審核') return dd.status;
        if (!clicked) { // 如果後台跳出確認視窗，按確認
          var dlg = doc.querySelector('[role=dialog]');
          if (dlg) {
            var ok = [].find.call(dlg.querySelectorAll('button'), function (x) { return /^(確定|確認|接單|是)$/.test(x.innerText.replace(/\s+/g, '')); });
            if (ok) { ok.click(); clicked = true; }
          }
        }
        return null;
      }, 15000, 250);
      if (res === '已接單') return { ok: true, msg: '✓ 已接單' };
      if (res) return { ok: false, msg: '✗ 狀態變成「' + res + '」，請到後台確認' };
      return { ok: false, msg: '✗ 按了接單但沒看到狀態改變，請到後台確認' };
    } finally { f.remove(); }
  }

  async function doAccept() {
    if (busy) return;
    busy = true;
    var todo = orders.filter(function (o) { return o.checked && !(o.result && o.result.ok); });
    var n = 0, okN = 0;
    $('mk-ac-foot').innerHTML = '接單中…';
    try {
      await pool(todo, 2, async function (o) {
        try { o.result = await acceptOne(o); } catch (e) { o.result = { ok: false, msg: '✗ ' + e.message }; }
        if (o.result.ok) { okN++; o.checked = false; }
        n++; setStatus('接單中…（' + n + '/' + todo.length + '）');
      });
      setStatus('接單完成：成功 <b>' + okN + '</b> 筆' + (todo.length - okN ? '，<span style="color:#b71c1c;">沒接單 ' + (todo.length - okN) + ' 筆（看下面紅字原因）</span>' : '') + '。');
    } finally { busy = false; render(); }
  }

  $('mk-ac-run').onclick = run;
  run();
})();
