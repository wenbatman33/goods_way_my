# MyWay 預約搶位（Chrome 插件）

## 安裝
1. 編輯 `.env`，填入帳單資料（格式見 `.env.example`）
2. Chrome 開 `chrome://extensions` → 右上開「開發人員模式」→「載入未封裝項目」→ 選本資料夾
3. 之後改 `.env`：popup 按「重新載入 .env」（改 JS 則要在 extensions 頁按重新整理）

## 使用（9/29 18:00 開賣）
1. **當天提早登入會員**（結帳必須登入，Email 收驗證碼）：右上角帳號 → 登入。
   驗證方式：隨便加一個場次到購物車 → 前往結帳，若直接進入結帳頁（不是登入頁）就代表已登入，再清空購物車
   17:55 前開好 https://mywaygoods.com/
2. 點插件 icon →「▶ 開始（待命）」
3. **分頁保持在前景、電腦不要睡眠**
4. 17:59:50 起每 `POLL_INTERVAL_MS` 讀一次商品 JSON → 挑目標日期最早有名額的場次 → 清空購物車、加入 1 張 → 進結帳 → 填帳單 → 按「完成訂單」

## 流程細節
- 商品：`PRODUCT_URL` 留空時，會自動掃首頁找出日期選項含 `TARGET_DATE` 的商品
- 場次：只挑 `available=true` 的，依開始時間由早到晚，可用 `EARLIEST_START` / `LATEST_START` 限制範圍
- 限制：Shopify 商品 JSON 最多回傳 250 個場次，場次太多時較後面的日期可能讀不到

## 預演
先把 `AUTO_COMPLETE_ORDER=false`、`START_AT=` 留空，對現有商品跑一次，確認結帳頁欄位都有填上，
**然後手動清空購物車、不要按完成訂單**。確認沒問題再改回 `true` 並設定開賣時間。
