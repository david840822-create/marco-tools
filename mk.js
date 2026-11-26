/* 馬可小幫手：功能選單（GitHub 上的 mk.js）
 * 書籤每次都會抓這個檔案的最新版；各功能放在同資料夾的獨立檔案，按到才載入：
 *   print.js  產生出貨單（依車號排序，含自動分配車次）
 *   accept.js 檢查待接單（備註檢查＋常態OK清單＋接單）
 *   price.js  更新批次價格（今天的價格檔 → 匯出檔填價 → 匯入 → 核對）
 *   morning.js 會計早上核對（今天到貨：重量／實價品／運費檢查）
 */
(function () {
  if (!/super-marco\.com$/.test(location.hostname)) {
    alert('請在馬可供應商後台（supply-admin.super-marco.com）的頁面上使用「馬可小幫手」。');
    return;
  }
  var cs = document.currentScript && document.currentScript.src;
  var BASE = cs ? cs.replace(/[^\/]*(\?.*)?$/, '') : 'https://david840822-create.github.io/marco-tools/';
  var SHEET_URL = 'https://docs.google.com/spreadsheets/d/17vD0XABzHYb6wLdZcL94xV4zEflM8MF7v4yyhJ7cc5o/edit';

  var old = document.getElementById('mk-menu');
  if (old) { old.remove(); return; } // 再按一次書籤 = 關閉選單

  var ITEMS = [
    { icon: '📋', name: '檢查待接單', desc: '檢查明天的待審核訂單有沒有備註，再一次接單', file: 'accept.js' },
    { icon: '💲', name: '更新批次價格', desc: '建好批次後按：用今天的價格檔一鍵更新價格（17:00 後）', file: 'price.js' },
    { icon: '🖨️', name: '產生出貨單', desc: '先自動分配車次，再依車號排序列印出貨明細', file: 'print.js' },
    { icon: '🔄', name: '自動匯入理貨結果', desc: '辦公室電腦開著：理貨裝箱按「全部確認回傳」後，自動匯入馬可（這個分頁要一直開著）', file: 'tally-import.js' },
    { icon: '☀️', name: '會計早上核對', desc: '今天到貨的訂單：重量、實價品、運費一次檢查；沒問題的可勾選改成已送達', file: 'morning.js' },
    { icon: '📝', name: '常態 OK 清單', desc: '打開 Google 試算表（主管在這裡審核）', url: SHEET_URL }
  ];

  var box = document.createElement('div');
  box.id = 'mk-menu';
  box.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;width:300px;background:#fff;border:2px solid #2e7d4f;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);font:14px/1.5 "Microsoft JhengHei",sans-serif;color:#222;overflow:hidden;';
  box.innerHTML = '<div style="display:flex;align-items:center;background:#2e7d4f;color:#fff;padding:8px 12px;"><b style="flex:1;font-size:16px;">馬可小幫手</b>' +
    '<button id="mk-menu-x" style="background:none;border:0;color:#fff;font-size:18px;cursor:pointer;" title="關閉">✕</button></div>' +
    ITEMS.map(function (it, i) {
      return '<button data-i="' + i + '" class="mk-menu-it" style="display:block;width:100%;text-align:left;background:#fff;border:0;border-top:1px solid #eee;padding:10px 12px;cursor:pointer;font:inherit;">' +
        '<div style="font-size:15px;font-weight:700;">' + it.icon + ' ' + it.name + '</div>' +
        '<div style="color:#666;font-size:12px;">' + it.desc + '</div></button>';
    }).join('') +
    '<div id="mk-menu-msg" style="padding:6px 12px;color:#b71c1c;font-size:12px;"></div>';
  document.body.appendChild(box);
  document.getElementById('mk-menu-x').onclick = function () { box.remove(); };

  /* ---------- 常態 OK 清單有「待審核」：選單最上面提醒主管去審 ---------- */
  var OK_API = 'https://script.google.com/macros/s/AKfycbxQK0BUWNmiNjh5sbU77y8X0YnerMfF7eakGQMjZJQxwsZBcw0Lh0QTDHjBognWIikpew/exec';
  var okNote = document.createElement('div');
  okNote.id = 'mk-menu-ok';
  okNote.style.display = 'none';
  box.insertBefore(okNote, box.children[1]);
  fetch(OK_API + '?action=list&t=' + Date.now()).then(function (r) { return r.json(); }).then(function (j) {
    var pend = ((j && j.list) || []).filter(function (x) { return x.status === '待審核'; });
    if (!pend.length) return;
    okNote.style.cssText = 'padding:8px 12px;font-size:13px;line-height:1.45;cursor:pointer;background:#fff4cc;color:#8a5a00;border-top:1px solid #f0d27a;';
    // 只提醒「有事要處理」，明細到試算表看
    okNote.innerHTML = '📝 常態 OK 清單有 <b>' + pend.length + ' 筆待審核</b>' +
      '<div style="font-size:12px;margin-top:2px">👉 主管點這裡打開試算表審核</div>';
    okNote.onclick = function () { window.open(SHEET_URL, '_blank'); };
  }).catch(function () {});

  /* ---------- 每天提醒：今天的出貨批次有沒有更新價格（紀錄由「更新批次價格」寫入，三台電腦共用） ---------- */
  var PRICE_API = 'https://script.google.com/macros/s/AKfycbwkph6A7dMEcndMv1WhczRhX0O0EIbZ3XPCgC4DUuAjybAHYP9zRkVJ9c_BN6jWUexW/exec';
  var note = document.createElement('div');
  note.id = 'mk-menu-price';
  note.style.cssText = 'padding:6px 12px;font-size:12px;color:#888;border-top:1px solid #eee;';
  note.textContent = '檢查今天的批次價格有沒有更新…';
  box.insertBefore(note, box.children[1]);
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function mdLabel(d) { var p = String(d).split('-'); return p.length === 3 ? (+p[1]) + '/' + (+p[2]) : d; }
  function batchDay(b) { // 批次建立的作業日（凌晨 0～6 點建的算前一天）
    var m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(b.date || '');
    if (!m) return '';
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (b.time && +b.time.slice(0, 2) < 6) d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function readBatchList(doc) {
    var seen = {}, list = [];
    doc.querySelectorAll('a[href*="/delivery-batch/edit/"]').forEach(function (a) {
      var m = /\/delivery-batch\/edit\/(\d+)$/.exec(a.getAttribute('href') || '');
      var tr = a.closest('tr');
      if (!m || !tr || seen[m[1]]) return;
      seen[m[1]] = 1;
      var t = (tr.innerText || '').replace(/\s+/g, ' ');
      var dt = /(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2})/.exec(t) || [];
      list.push({ no: (/\b(\d{8})\b/.exec(t) || [])[1] || '', date: dt[1] || '', time: dt[2] || '', status: (/(進行中|已結束|已停止|已中斷|[^\s]*完成)/.exec(t) || [])[1] || '' });
    });
    return list;
  }
  function batchesFromListPage() { // 在隱藏視窗打開出貨批次列表，等清單穩定再讀
    return new Promise(function (resolve) {
      var f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-12000px;top:0;width:1400px;height:1000px;visibility:hidden;';
      f.src = location.origin + '/delivery-batch/list';
      document.body.appendChild(f);
      var last = -1, same = 0, t0 = Date.now();
      var iv = setInterval(function () {
        var l = [];
        try { l = readBatchList(f.contentDocument); } catch (e) {}
        if (l.length && l.length === last) same++; else same = 0;
        last = l.length;
        if (same >= 3 || Date.now() - t0 > 30000) { clearInterval(iv); f.remove(); resolve(l); }
      }, 300);
    });
  }
  (async function () {
    try {
      var bs = readBatchList(document);
      if (!bs.length) bs = await batchesFromListPage();
      var seen = [], stop = []; // 順便回報看到的批次（給每天定時寄信提醒用）
      bs.forEach(function (b) { if (/^\d{8}$/.test(b.no)) (/已停止|已中斷/.test(b.status) ? stop : seen).push(b.no); });
      var st = await fetch(PRICE_API + '?action=status&seen=' + seen.slice(0, 30).join(',') + '&stop=' + stop.slice(0, 30).join(','), { redirect: 'follow' }).then(function (r) { return r.json(); });
      if (!st || !st.ok) throw new Error('');
      var todays = bs.filter(function (b) { return b.no && batchDay(b) === st.today && !/已停止|已中斷/.test(b.status); });
      if (!todays.length) { note.remove(); return; } // 今天還沒建批次：不提示
      // 只有每天第一批（有預訂單）需要更新價格，之後的批次不提醒
      todays.sort(function (x, y) { return (x.date + x.time) < (y.date + y.time) ? -1 : 1; });
      todays = todays.slice(0, 1);
      var todo = todays.filter(function (b) { var e = st.log && st.log[b.no]; return !e || e.file !== st.today; });
      if (!todo.length) {
        note.style.cssText = 'padding:6px 12px;font-size:13px;color:#1b5e20;background:#e8f5e9;border-top:1px solid #c8e6c9;';
        note.textContent = '✓ 今天（' + mdLabel(st.today) + '）第一批 ' + todays[0].no + ' 價格已更新';
        return;
      }
      var late = new Date().getHours() >= 17 || new Date().getHours() < 6;
      note.style.cssText = 'padding:8px 12px;font-size:13px;line-height:1.45;cursor:pointer;border-top:1px solid #eee;' +
        (late ? 'background:#c62828;color:#fff;font-weight:700;' : 'background:#fff8e1;color:#8a5a00;');
      note.innerHTML = '⚠ 今天（' + mdLabel(st.today) + '）第一批 ' + todo[0].no + ' <b>還沒更新價格</b>' +
        '<div style="font-weight:400;font-size:12px;margin-top:2px">' + (late ? '👉 點這裡馬上更新價格' : '價格檔約 17:00 產生，17:00 後記得更新（點這裡打開）') + '</div>';
      note.onclick = function () { var b = box.querySelector('.mk-menu-it[data-i="1"]'); if (b) b.click(); };
    } catch (e) {
      note.textContent = '（讀不到價格更新紀錄）';
    }
  })();
  [].forEach.call(box.querySelectorAll('.mk-menu-it'), function (b) {
    b.onmouseenter = function () { b.style.background = '#f1f8f3'; };
    b.onmouseleave = function () { b.style.background = '#fff'; };
    b.onclick = function () {
      var it = ITEMS[+b.dataset.i];
      if (it.url) { window.open(it.url, '_blank'); box.remove(); return; }
      var s = document.createElement('script');
      s.src = BASE + it.file + '?t=' + Date.now();
      s.onload = function () { box.remove(); };
      s.onerror = function () { document.getElementById('mk-menu-msg').textContent = '載入失敗，請檢查網路後再試一次。'; };
      document.body.appendChild(s);
    };
  });
})();
