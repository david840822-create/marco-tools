# 給 Claude 的工作說明（馬可小幫手）

先讀 `README.md`（架構、檔案、後台眉角都在那裡）。以下是一定要遵守的規則。

## 溝通
- 一律用**繁體中文（台灣用語）**回覆。使用者與現場行政人員不是工程師：講結果、講怎麼操作，少講技術細節。

## 絕對規則
1. **接單不能取消、不能退回。** 不得在真實訂單上按「接單」或「確定接單」，除非使用者在對話中明確同意「那一筆」。後台詳情頁「接單」旁邊是「取消訂單」，任何時候都不要點。
2. **上傳到 GitHub = 三台電腦立刻生效。** 一定先在後台實測通過才上傳；上傳後打開 GitHub Pages 網址確認內容是新的，再用書籤方式實測一次。
3. 「產生出貨單」會真的分配車次（只動未分配的訂單）。測試要用使用者指定的測試批次。
4. 只透過後台自己的頁面（隱藏 iframe、讀 DOM、按按鈕）操作。**不要**拿 localStorage 裡的 token 直接呼叫 api.super-marco.com（使用者端曾拒絕這種做法）。
5. 這個 repo 是公開的：不要寫入密碼、token、個人信箱、客戶資料。
6. 常態 OK 清單的核准只能由主管在試算表做；工具只能「送審」（新增「待審核」列），不能幫忙核准。

## 開發與測試方式
- 修改後先在後台頁面注入測試：可用 Claude in Chrome，在頁面建一個 `<input type=file>`，用 file_upload 上傳本機檔案，再 `(0,eval)(await file.text())` 執行。讀取類功能可以在真實資料上「只看不按」測試。
- `javascript_tool` 的輸出若含網址查詢字串或疑似 token 會被遮蔽，回傳時只回數量／結構。
- 隱藏 iframe 讀頁面時一律「等數字穩定」：連續幾次讀到一樣的結果才算載入完成（後台很多數字會先顯示 0 或舊資料）。
- 上傳 GitHub：用 Chrome 開 `https://github.com/david840822-create/marco-tools/upload/main`（子資料夾用 `/upload/main/資料夾名`），file_upload 檔案後 Commit。
- Markdown 檔裡不要出現 Liquid 語法（兩個左大括號、或左大括號加百分號），GitHub Pages 的 Jekyll 會建置失敗，連帶 JS 也不會更新。
- 改了 `installer/` 才需要 `node installer/build-bat.js` 重做安裝檔並重新發給各台電腦；只改 `mk.js`／`accept.js`／`print.js` 不用重裝。

## 常態 OK 清單 Apps Script
- 原始碼備份在 `apps-script/ok-list.gs`；實際執行的在試算表的 Apps Script 專案。
- 介面：`GET ?action=list` → `{ok, list:[{status,customer,product,note,scope}]}`（只回「核准」「待審核」）；`GET ?action=submit&customer=&product=&note=&scope=此客戶|所有客戶&who=` → `{ok}` 或 `{ok, dup:true, status}`。
- 更新程式要「管理部署作業 → 編輯 → 新版本」，**不要新增部署**（網址會變，`accept.js` 的 `OK_API` 要跟著改）。

## 業務規則（使用者定的）
- 檢查待接單的日期：早上 6 點以後 → 明天；0～6 點 → 今天。
- 備註比對要保守：客戶＋商品＋備註完全相同（忽略空白、全半形、×x*）。名稱相似的客戶（改名、連鎖分店）只提醒、不自動套用。
- 沒備註或備註全部已核准 → 🟢 預先勾選；其他 → 🔴 不勾選並顯示備註。LINE 群由人看，不自動化，也不自動回覆客人。
- 出貨單：配送路線 n車 → 車次第 n 個字母（1車→A … 6車→F），缺的車次用後台「新增車次」補；同車同客人的單排在一起。
- 建出貨批次目前維持人工（約 20 張以上建一批，最後一批約 23:30）。
