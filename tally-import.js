/* 馬可小幫手：自動匯入理貨結果（tally-import.js）
 *
 * 用法：辦公室電腦開著馬可後台（任何一頁），從「馬可小幫手」選單按「自動匯入理貨結果」，
 *       右下角出現面板後，這個分頁就一直開著、不要換頁、不要關（電腦不要睡眠）。
 *
 * 流程：理貨作業 App 裝箱按「全部確認回傳」→ 試算表寫好 → 暫存區（Firebase）標記「待匯入馬可」
 *       → 這裡等 1 分鐘沒人再改 → 跟理貨 App 拿整份批次 xlsx（＝檔案→下載→Excel 同一份）
 *       → 用後台列表頁自己的「從 Google Sheet 匯入訂單」按鈕匯入 → 把結果寫回暫存區，
 *         儀表板就會顯示「已匯入馬可」（失敗會記錄原因）。
 *       確認後又有人修改 → 儀表板要求重新「全部確認回傳」→ 這裡會再匯入一次（後台是覆蓋，不是累加）。
 *
 * 規則（README「自動匯入理貨結果」有完整說明）：
 *   - 只透過後台自己的頁面按鈕匯入（隱藏 iframe），不直接呼叫 api.super-marco.com。
 *   - 理貨 App 網址、Firebase 設定都不寫進這個公開的 repo：網址每台電腦第一次使用時貼上，存在這台電腦；
 *     Firebase 設定跟理貨 App 拿（?api=stage-config）。
 *   - 測試批次（★測試用、檔名有「測試」）永遠不匯入：裡面的訂單商品 ID 是真的訂單。
 *   - 模式「每批先問我」：每批都要按「匯入」才會做（第一次上線先用這個）；「自動匯入」：確認後 1 分鐘自動做。
 */
(function () {
  'use strict';
  if (!/super-marco\.com$/.test(location.hostname)) {
    alert('請在馬可供應商後台（supply-admin.super-marco.com）的頁面上使用「自動匯入理貨結果」。');
    return;
  }
  if (window.__tallyImport && window.__tallyImport.alive) { window.__tallyImport.show(); return; }

  var VERSION = '2026-11-26b';
  var ORIGIN = location.origin;
  var SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
  var URL_KEY = 'mk-tally-url', MODE_KEY = 'mk-tally-import-mode', NAME_KEY = 'mk-tally-station';
  var WAIT_MS = 60 * 1000;                 // 全部確認後等 1 分鐘，沒人再改才匯入
  var MAX_AGE_MS = 20 * 3600 * 1000;       // 超過 20 小時前確認的不自動匯入（可手動按）
  var STALE_IMPORTING_MS = 10 * 60 * 1000; // 「匯入中」超過 10 分鐘沒結果＝上次中斷，可以重來
  var RETRY_AFTER_MS = 2 * 60 * 1000;      // 失敗後 2 分鐘自動再試一次（只試一次）
  var HEARTBEAT_MS = 60 * 1000;
  var KEEPALIVE_MS = 15 * 60 * 1000;       // 每 15 分鐘確認後台還登入著
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var IMPORT_LABEL = '從GoogleSheet匯入訂單';
  var DRY = Boolean(window.__TALLY_IMPORT_DRYRUN); // 測試：只下載檔案、不按匯入

  var api = window.__tallyImport = { alive: true, version: VERSION, dry: DRY };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function txt(e) { return (e && (e.innerText || e.textContent) || '').replace(/\s+/g, ' ').trim(); }
  function hm(t) { var d = new Date(Number(t) || 0); return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(); }
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }

  /* ---------- 理貨 App 網址（每台電腦第一次貼一次） ---------- */
  function tallyUrl() {
    var u = lsGet(URL_KEY);
    if (/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(u)) return u;
    u = prompt('第一次使用：請貼上「理貨作業」的網址（平板上開的那個，結尾是 /exec）');
    u = String(u || '').trim().replace(/[?#].*$/, '');
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(u)) { alert('網址不對：要是 https://script.google.com/macros/s/…/exec'); return ''; }
    lsSet(URL_KEY, u);
    return u;
  }
  async function getJson(url) {
    var r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /* ---------- 面板 ---------- */
  var box = document.createElement('div');
  box.id = 'mk-tally-import';
  box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;width:420px;max-height:70vh;display:flex;flex-direction:column;background:#fff;border:2px solid #0b57d0;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);font:14px/1.5 "Microsoft JhengHei",sans-serif;color:#222;';
  box.innerHTML =
    '<div style="display:flex;align-items:center;background:#0b57d0;color:#fff;padding:8px 12px;border-radius:8px 8px 0 0;">' +
    '<b style="flex:1;font-size:16px;">🔄 自動匯入理貨結果' + (DRY ? '（試跑：不匯入）' : '') + '</b>' +
    '<button data-act="min" style="background:none;border:0;color:#fff;font-size:16px;cursor:pointer;" title="縮小">—</button>' +
    '<button data-act="close" style="background:none;border:0;color:#fff;font-size:18px;cursor:pointer;" title="停止">✕</button></div>' +
    '<div data-part="body" style="overflow:auto;padding:8px 12px;">' +
    '<div data-part="status" style="font-weight:700;"></div>' +
    '<div style="margin:6px 0;font-size:13px;">模式：' +
    '<label style="margin-right:10px;cursor:pointer;"><input type="radio" name="mk-ti-mode" value="ask"> 每批先問我</label>' +
    '<label style="cursor:pointer;"><input type="radio" name="mk-ti-mode" value="auto"> 確認後自動匯入</label></div>' +
    '<div data-part="list"></div>' +
    '<details style="margin-top:6px;font-size:12px;color:#555;"><summary style="cursor:pointer;">紀錄</summary><div data-part="log"></div></details>' +
    '<div style="font-size:12px;color:#777;margin-top:6px;">這個分頁請一直開著，不要換頁；電腦不要睡眠。</div>' +
    '</div>';
  document.body.appendChild(box);
  var $ = function (p) { return box.querySelector('[data-part="' + p + '"]'); };
  var mode = lsGet(MODE_KEY) === 'auto' ? 'auto' : 'ask';
  box.querySelectorAll('input[name="mk-ti-mode"]').forEach(function (r) {
    r.checked = r.value === mode;
    r.onchange = function () {
      if (r.value === 'auto' && !confirm('改成「確認後自動匯入」？\n裝箱按「全部確認回傳」1 分鐘後，就會自動匯入馬可（會覆蓋這批訂單的數量）。')) { render(); return; }
      mode = r.value; lsSet(MODE_KEY, mode); heartbeat(); render(); tick();
    };
  });
  box.querySelector('[data-act="min"]').onclick = function () { var b = $('body'); b.style.display = b.style.display === 'none' ? '' : 'none'; };
  box.querySelector('[data-act="close"]').onclick = function () {
    if (!confirm('停止自動匯入？停止後，晚上確認的批次要手動匯入。')) return;
    stop();
  };
  api.show = function () { $('body').style.display = ''; box.scrollIntoView(); };
  var logs = [];
  function log(msg) {
    logs.unshift(hm(Date.now()) + ' ' + msg);
    logs = logs.slice(0, 40);
    $('log').innerHTML = logs.map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');
    try { console.log('[自動匯入] ' + msg); } catch (e) {}
  }
  var conn = { text: '連線中…', bad: false };
  function setConn(text, bad) { conn = { text: text, bad: Boolean(bad) }; render(); }

  /* ---------- 暫存區（Firebase） ---------- */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error('載入失敗 ' + src)); };
      document.head.appendChild(s);
    });
  }
  var cfg = null, fb = null, db = null, unsub = null, timers = [];
  var docs = {};   // fileId → 暫存區資料
  var names = {};  // fileId → {name, test}
  var busy = null; // 正在匯入的 fileId
  var marcoLogin = { ok: true, at: 0 };
  var station = lsGet(NAME_KEY) || ('辦公室電腦-' + Math.random().toString(36).slice(2, 6));
  lsSet(NAME_KEY, station);

  async function start() {
    var url = tallyUrl();
    if (!url) { setConn('沒有理貨作業網址，請關掉面板重新開一次', true); return; }
    try {
      cfg = await getJson(url + '?api=stage-config');
      if (!cfg || !cfg.ok || !cfg.firebase) throw new Error('理貨 App 回應不正確（可能還是舊版）');
    } catch (e) {
      setConn('拿不到理貨 App 設定：' + e.message + '（網址對嗎？）', true);
      log('拿不到理貨 App 設定：' + e.message);
      if (confirm('理貨作業網址可能貼錯了，要重新貼嗎？')) { lsSet(URL_KEY, ''); return start(); }
      return;
    }
    if (!window.firebase || !window.firebase.firestore) {
      await loadScript(SDK + 'firebase-app-compat.js');
      await loadScript(SDK + 'firebase-auth-compat.js');
      await loadScript(SDK + 'firebase-firestore-compat.js');
    }
    // 用自己的 app 名稱，不影響頁面上其他東西
    fb = window.firebase.apps.find(function (a) { return a.name === 'tallyImport'; }) || window.firebase.initializeApp(cfg.firebase, 'tallyImport');
    db = fb.firestore();
    // 馬可後台頁面上 Firestore 預設的串流連線會一直斷（實測 2026-11-26），改用長輪詢就正常
    try { db.settings({ experimentalForceLongPolling: true }); } catch (e) {}
    await fb.auth().signInAnonymously();
    unsub = db.collection('tallyStage').where('marco.status', 'in', ['pending', 'importing', 'error']).onSnapshot({ includeMetadataChanges: true }, function (qs) {
      var seen = {};
      qs.forEach(function (d) { seen[d.id] = 1; docs[d.id] = d.data(); ensureName(d.id); });
      // 離開「待匯入」名單的批次（匯入完成、或儀表板手動標記）：讀一次最新狀態留在面板上顯示
      Object.keys(docs).forEach(function (id) {
        if (seen[id]) return;
        db.collection('tallyStage').doc(id).get().then(function (s) {
          var d = s.exists ? s.data() : null;
          if (d && d.marco && d.marco.status === 'done') docs[id] = d; else delete docs[id];
          render();
        }).catch(function () {});
      });
      if (qs.metadata.fromCache) setConn('連線中…（還沒連上暫存區）', true);
      else setConn('已連線，等待「全部確認回傳」', false);
      tick();
    }, function (err) { setConn('暫存區連線中斷：' + (err && err.message || err) + '（會自動重連）', true); });
    timers.push(setInterval(tick, 10000));
    timers.push(setInterval(heartbeat, HEARTBEAT_MS));
    timers.push(setInterval(checkMarcoLogin, KEEPALIVE_MS));
    heartbeat();
    checkMarcoLogin();
    document.title = '🔄 自動匯入中｜馬可後台';
    log('開始（' + station + '，模式：' + (mode === 'auto' ? '自動' : '每批先問') + '）');
  }
  function stop() {
    api.alive = false;
    try { if (unsub) unsub(); } catch (e) {}
    timers.forEach(clearInterval);
    try { if (db) db.collection('tallyMeta').doc('importer').set({ at: Date.now(), stopped: true, station: station }, { merge: true }); } catch (e) {}
    box.remove();
    document.title = '馬可供應商後台';
  }
  function heartbeat() {
    if (!db) return;
    db.collection('tallyMeta').doc('importer').set({
      at: Date.now(), station: station, mode: mode, version: VERSION, dry: DRY, busy: busy || '',
      marcoLogin: marcoLogin.ok, stopped: false
    }).catch(function () {});
  }
  async function ensureName(fileId) {
    if (names[fileId]) return;
    names[fileId] = { name: '（讀取批次名稱…）', test: cfg && fileId === cfg.testFileId };
    try {
      var s = await db.collection('tallySnap').doc(fileId).get();
      var title = '';
      if (s.exists) { try { title = JSON.parse(s.data().json).title || ''; } catch (e) {} }
      names[fileId] = { name: title || fileId.slice(0, 8), test: (cfg && fileId === cfg.testFileId) || /測試/.test(title) };
    } catch (e) { names[fileId].name = fileId.slice(0, 8); }
    render();
  }

  /* ---------- 判斷每一批現在該做什麼 ---------- */
  function stateOf(fileId, d) {
    var c = d && d.confirm, m = (d && d.marco) || {}, info = names[fileId] || {}, nowT = Date.now();
    if (!c) return { k: 'none', text: '還沒有全部確認' };
    if (Number(d.rev || 0) > Number(c.rev || 0)) return { k: 'redo', text: '確認後又有修改：等裝箱重新「全部確認回傳」' };
    if (m.status === 'done') return { k: 'done', text: '已匯入馬可 ' + hm(m.at) };
    if (info.test && !DRY) return { k: 'test', text: '測試批次：不會匯入馬可' };
    if (m.status === 'importing' && nowT - Number(m.at || 0) < STALE_IMPORTING_MS) return { k: 'importing', text: '匯入中…（' + (m.by || '') + '）' };
    var age = nowT - Number(c.at || 0);
    if (m.status === 'error') {
      var canRetry = Number(m.tries || 1) < 2 && nowT - Number(m.at || 0) > RETRY_AFTER_MS;
      return { k: 'error', text: '匯入失敗：' + (m.msg || '原因不明'), retry: canRetry };
    }
    if (age > MAX_AGE_MS) return { k: 'old', text: '太久以前確認的（' + hm(c.at) + '），不自動匯入' };
    if (age < WAIT_MS) return { k: 'wait', text: '已確認 ' + hm(c.at) + '，等 ' + Math.ceil((WAIT_MS - age) / 1000) + ' 秒確定沒人再改' };
    return { k: 'ready', text: '已確認 ' + hm(c.at) + '，可以匯入' };
  }

  function render() {
    if (!api.alive) return;
    var st = $('status');
    st.textContent = (conn.bad ? '⚠ ' : '✓ ') + conn.text + (marcoLogin.ok ? '' : '｜⚠ 馬可後台好像登出了，請重新登入後再開一次');
    st.style.color = conn.bad || !marcoLogin.ok ? '#b3261e' : '#1b5e20';
    box.querySelectorAll('input[name="mk-ti-mode"]').forEach(function (r) { r.checked = r.value === mode; });
    var ids = Object.keys(docs).sort(function (a, b) { return Number((docs[b].confirm || {}).at || 0) - Number((docs[a].confirm || {}).at || 0); });
    if (!ids.length) { $('list').innerHTML = '<div style="color:#777;">目前沒有待匯入的批次。</div>'; return; }
    $('list').innerHTML = ids.map(function (id) {
      var s = stateOf(id, docs[id]), info = names[id] || {};
      var color = { done: '#1b5e20', error: '#b3261e', redo: '#b3261e', test: '#777', old: '#8a5a00' }[s.k] || '#0b57d0';
      var canPress = !busy && (s.k === 'ready' || s.k === 'error' || s.k === 'old' || s.k === 'wait');
      return '<div style="border-top:1px solid #eee;padding:6px 0;display:flex;gap:8px;align-items:center;">' +
        '<div style="flex:1;"><div style="font-weight:700;">' + esc(info.name || id.slice(0, 8)) + '</div>' +
        '<div style="font-size:12px;color:' + color + ';">' + esc(s.text) + '</div></div>' +
        (canPress ? '<button data-import="' + esc(id) + '" style="min-height:34px;padding:2px 12px;border-radius:6px;border:1px solid #0b57d0;background:#0b57d0;color:#fff;font-weight:700;cursor:pointer;">匯入</button>' : '') +
        '</div>';
    }).join('');
    $('list').querySelectorAll('[data-import]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-import'), info = names[id] || {};
        if (!confirm('匯入「' + (info.name || id) + '」到馬可？\n會用試算表現在的數量覆蓋馬可後台這批訂單。')) return;
        runImport(id, true);
      };
    });
  }

  function tick() {
    if (!api.alive || !db) return;
    render();
    if (busy || mode !== 'auto' || !marcoLogin.ok) return;
    var ids = Object.keys(docs);
    for (var i = 0; i < ids.length; i += 1) {
      var s = stateOf(ids[i], docs[ids[i]]);
      if (s.k === 'ready' || (s.k === 'error' && s.retry)) { runImport(ids[i], false); return; }
    }
  }

  // 每次匯入（成功或失敗）都加一筆到 marco.log，理貨儀表板的「匯入紀錄」會列出來（第幾次、誰、後台訊息）
  function logEntry(ok, rev, msg) {
    return window.firebase.firestore.FieldValue.arrayUnion({
      at: Date.now(), ok: Boolean(ok), rev: Number(rev || 0), by: '自動匯入（' + station + '）',
      msg: String(msg || '').slice(0, 200), dry: Boolean(DRY)
    });
  }

  /* ---------- 匯入一批 ---------- */
  async function runImport(fileId, manual) {
    if (busy) return;
    busy = fileId; heartbeat(); render();
    var ref = db.collection('tallyStage').doc(fileId);
    var info = names[fileId] || {};
    var claimedRev = 0;
    try {
      // 1. 先在暫存區佔住（同時間只有一台會做），佔的時候再檢查一次狀態
      await db.runTransaction(async function (tx) {
        var snap = await tx.get(ref);
        var d = snap.data() || {}, s = stateOf(fileId, d), m = d.marco || {};
        var allowed = s.k === 'ready' || (s.k === 'error' && (s.retry || manual)) || (manual && (s.k === 'old' || s.k === 'wait'));
        if (!allowed) throw new Error('SKIP:' + s.text);
        claimedRev = Number(d.confirm.rev || 0);
        tx.update(ref, {
          'marco.status': 'importing', 'marco.at': Date.now(), 'marco.by': '自動匯入（' + station + '）',
          'marco.rev': claimedRev, 'marco.tries': m.status === 'error' ? Number(m.tries || 1) + 1 : 1,
          'marco.startedAt': Date.now(),
          'marco.msg': window.firebase.firestore.FieldValue.delete()
        });
      });
      log('開始匯入：' + info.name);

      // 2. 跟理貨 App 拿整份 xlsx
      var j = await getJson(tallyUrl() + '?api=marco-xlsx&fileId=' + encodeURIComponent(fileId));
      if (!j.ok) throw new Error('理貨 App 匯出失敗：' + j.error);
      if (j.test && !DRY) throw new Error('這是測試批次，不匯入馬可');
      var bin = atob(j.b64), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('拿到的不是 Excel 檔');
      var fileName = String(j.name || '理貨表格').replace(/[\\/:*?"<>|]/g, '_') + '.xlsx';
      log('已下載 ' + fileName + '（' + Math.round(bytes.length / 1024) + ' KB）');

      // 3. 匯入前最後確認：這段時間沒人改過
      var latest = (await ref.get()).data() || {};
      if (Number(latest.rev || 0) > claimedRev || Number((latest.confirm || {}).rev || 0) !== claimedRev) {
        await ref.update({ 'marco.status': 'pending', 'marco.at': Date.now(), 'marco.msg': '匯入前發現又有修改，先不匯入' });
        log('取消：' + info.name + ' 匯入前又有修改');
        return;
      }

      // 4. 用後台自己的「從 Google Sheet 匯入訂單」按鈕匯入
      var msg;
      if (DRY) msg = '試跑：檔案已下載（' + Math.round(bytes.length / 1024) + ' KB），沒有按匯入';
      else msg = (await importFile(new Blob([bytes], { type: XLSX_MIME }), fileName)).msg;
      var failed = !msg || /失敗|錯誤|error|fail|找不到|不存在|無法/i.test(msg);
      await ref.update({
        'marco.status': failed ? 'error' : 'done', 'marco.at': Date.now(), 'marco.rev': claimedRev,
        'marco.msg': msg || '後台沒有顯示匯入結果', 'marco.file': fileName, 'marco.bytes': bytes.length, 'marco.dry': DRY,
        'marco.log': logEntry(!failed, claimedRev, msg || '後台沒有顯示匯入結果')
      });
      log((failed ? '⚠ 匯入失敗：' : '✓ 已匯入：') + info.name + '｜後台訊息：' + (msg || '（沒有）'));
    } catch (e) {
      var text = String(e && e.message || e);
      if (/^SKIP:/.test(text)) { log('略過 ' + info.name + '：' + text.slice(5)); }
      else {
        log('⚠ 匯入失敗：' + info.name + '｜' + text);
        if (/登出|login/i.test(text)) marcoLogin = { ok: false, at: Date.now() };
        try { await ref.update({ 'marco.status': 'error', 'marco.at': Date.now(), 'marco.msg': text, 'marco.log': logEntry(false, claimedRev, text) }); } catch (e2) {}
      }
    } finally {
      busy = null; heartbeat(); render();
    }
  }

  /* ---------- 後台頁面操作（跟 price.js 的匯入同一招） ---------- */
  function loadFrame(url, ready, timeout) {
    timeout = timeout || 45000;
    return new Promise(function (resolve, reject) {
      var f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-12000px;top:0;width:1400px;height:1000px;visibility:hidden;';
      f.src = url;
      document.body.appendChild(f);
      var t0 = Date.now();
      var iv = setInterval(function () {
        var r = null;
        try {
          if (/\/login|\/verify/.test(f.contentWindow.location.pathname)) { clearInterval(iv); f.remove(); reject(new Error('馬可後台登出了，請重新登入')); return; }
          r = ready(f.contentDocument, f.contentWindow);
        } catch (e) { r = null; }
        if (r) { clearInterval(iv); resolve({ frame: f, result: r }); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); f.remove(); reject(new Error('後台頁面載入逾時')); }
      }, 250);
    });
  }
  function findImportLabel(d) {
    var lab = [].find.call(d.querySelectorAll('label'), function (l) { return l.innerText.replace(/\s+/g, '') === IMPORT_LABEL; });
    return lab && lab.querySelector('input[type=file]') && d.querySelector('a[href*="/delivery-batch/edit/"]') ? lab : null;
  }
  function feedbackText(d) {
    var els = d.querySelectorAll('[role=alert], [role=alertdialog], [role=dialog], .MuiSnackbar-root, .MuiAlert-message, .Toastify__toast, .ant-message, .ant-notification, .ant-modal-content');
    return [].map.call(els, function (e) { return txt(e); }).filter(Boolean).join('｜');
  }
  async function waitFor(fn, timeout, step) {
    var t0 = Date.now();
    while (Date.now() - t0 < (timeout || 15000)) {
      var r = null; try { r = fn(); } catch (e) { r = null; }
      if (r) return r;
      await sleep(step || 250);
    }
    return null;
  }
  async function importFile(blob, fileName) {
    var got = await loadFrame(ORIGIN + '/delivery-batch/list', findImportLabel, 45000);
    var f = got.frame, w = f.contentWindow, d = f.contentDocument;
    try {
      var before = feedbackText(d);
      var input = got.result.querySelector('input[type=file]');
      var file = new w.File([blob], fileName, { type: XLSX_MIME });
      var dt = new w.DataTransfer(); dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      input.dispatchEvent(new w.Event('change', { bubbles: true }));
      var msg = await waitFor(function () { var t = feedbackText(d); return t && t !== before ? t : null; }, 90000, 300);
      var last = '', same = 0, t0 = Date.now();
      while (msg && same < 4 && Date.now() - t0 < 20000) { // 結果視窗可能晚一點才出來：等文字穩定
        await sleep(400);
        var cur = feedbackText(d);
        if (cur === last) same++; else { same = 0; last = cur; }
      }
      return { msg: last || msg || '' };
    } finally { setTimeout(function () { f.remove(); }, 3000); }
  }
  async function checkMarcoLogin() {
    try {
      var got = await loadFrame(ORIGIN + '/delivery-batch/list', findImportLabel, 45000);
      got.frame.remove();
      marcoLogin = { ok: true, at: Date.now() };
    } catch (e) {
      marcoLogin = { ok: !/登出/.test(e.message), at: Date.now() };
      if (!marcoLogin.ok) log('⚠ 馬可後台登出了');
    }
    heartbeat(); render();
  }

  api.stateOf = stateOf; api.docs = docs; api.names = names; api.runImport = runImport; api.stop = stop;
  api.importFile = importFile;
  render();
  start().catch(function (e) { setConn('啟動失敗：' + (e && e.message || e), true); log('啟動失敗：' + (e && e.message || e)); });
})();
