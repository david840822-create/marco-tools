/* 馬可小幫手：功能選單（GitHub 上的 mk.js）
 * 書籤每次都會抓這個檔案的最新版；各功能放在同資料夾的獨立檔案，按到才載入：
 *   print.js  產生出貨單（依車號排序，含自動分配車次）
 *   accept.js 檢查待接單（備註檢查＋常態OK清單＋接單）
 *   price.js  更新批次價格（今天的價格檔 → 匯出檔填價 → 匯入 → 核對）
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
