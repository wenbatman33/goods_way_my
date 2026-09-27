// MyWay 預約搶位 — 內容腳本
// 流程：商品頁/任意頁（armed）→ 讀商品 JSON 挑場次 → 清空購物車 → 加入購物車 → 前往 /checkout
//       結帳頁 → 填帳單資料 →（可選）按「完成訂單」
(() => {
  const TAG = '[MyWay搶位]';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 背景 alarm 喚醒用：等待中的 sleep 可被提早叫醒（避免背景分頁計時器被降速）
  let wakeResolvers = [];
  const wakeableSleep = (ms) => new Promise((r) => { wakeResolvers.push(r); setTimeout(r, ms); });
  const wakeAll = () => { wakeResolvers.forEach((r) => r()); wakeResolvers = []; };
  const isCheckout = () => /\/checkouts?\b/.test(location.pathname);

  // ---------- 狀態 / 日誌 ----------
  async function getState() {
    const { config = {}, state = {} } = await chrome.storage.local.get(['config', 'state']);
    return { config, state };
  }
  async function setState(patch) {
    const { state = {} } = await chrome.storage.local.get('state');
    await chrome.storage.local.set({ state: { ...state, ...patch } });
  }
  // 頁面右上角狀態框
  function banner(text) {
    let el = document.getElementById('myway-booker-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'myway-booker-banner';
      el.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;max-width:340px;padding:10px 14px;' +
        'background:rgba(0,40,110,.92);color:#fff;font:13px/1.5 -apple-system,"PingFang TC",sans-serif;' +
        'border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none;white-space:pre-wrap';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = `🤖 MyWay 搶位\n${text}`;
  }

  async function log(msg) {
    const line = `${new Date().toLocaleTimeString()} ${msg}`;
    console.log(TAG, line);
    banner(line);
    const { logs = [] } = await chrome.storage.local.get('logs');
    logs.push(line);
    await chrome.storage.local.set({ logs: logs.slice(-80) });
  }

  // ---------- 小工具 ----------
  const parseMD = (s) => {
    const m = String(s || '').match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    return m ? `${+m[1]}/${+m[2]}` : null;
  };
  const parseStartMin = (s) => {
    const m = String(s || '').match(/(\d{1,2}):(\d{2})/);
    return m ? +m[1] * 60 + +m[2] : null;
  };
  const toMin = (hhmm) => (hhmm ? parseStartMin(hhmm) : null);

  // START_AT 支援「2026-09-29 18:00:00」或「18:00:00」（今天）；再減去提前秒數
  function parseStartAt(startAt, preSec) {
    if (!startAt) return null;
    const m = String(startAt).trim().match(/^(?:(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T]+)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const t = new Date();
    if (m[1]) t.setFullYear(+m[1], +m[2] - 1, +m[3]);
    t.setHours(+m[4], +m[5], +(m[6] || 0), 0);
    return new Date(t.getTime() - Math.max(0, parseFloat(preSec || '0')) * 1000);
  }

  // ---------- 找商品 ----------
  function handleFromUrl(url) {
    const m = String(url || '').match(/\/products\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  async function fetchProduct(handle) {
    const res = await fetch(`/products/${handle}.js?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`讀取商品失敗 HTTP ${res.status}`);
    return res.json();
  }

  // 從首頁 + 商品 sitemap 掃出所有商品，挑出（符合關鍵字且）日期選項含目標日期者
  async function discoverHandle(targetMD, excluded = [], keyword = '') {
    const sources = [`/?_=${Date.now()}`, `/sitemap_products_1.xml?_=${Date.now()}`];
    if (location.pathname !== '/' && !location.pathname.startsWith('/products/')) sources.push(`${location.pathname}?_=${Date.now()}`);
    const texts = await Promise.all(sources.map((u) => fetch(u, { cache: 'no-store' }).then((r) => r.text()).catch(() => '')));
    const kw = keyword ? new RegExp(keyword, 'i') : null;
    // 盯首頁的按鈕（COMING SOON 開放後會出現 href）與符合關鍵字的選單：連到分類頁/活動頁時，進去抓商品連結
    for (const url of watchLinks(texts[0], kw)) {
      texts.push(await fetch(url, { cache: 'no-store' }).then((r) => r.text()).catch(() => ''));
    }
    const handles = [...new Set(texts.flatMap((t) => [...t.matchAll(/\/products\/([^"'?#/\s<]+)/g)].map((m) => m[1])))];
    for (const h of handles) {
      if (excluded.includes(h)) continue;
      try {
        const p = await fetchProduct(h);
        if (kw && !kw.test(`${p.title} ${decodeURIComponent(h)}`)) continue;
        const hit = p.variants.some((v) => [v.option1, v.option2, v.option3].some((o) => parseMD(o) === targetMD));
        if (hit) return h;
      } catch (_) { /* 略過 */ }
    }
    return null;
  }

  // 回傳首頁中「按鈕」或「符合關鍵字的連結」所指向、非首頁也非商品頁的網址
  function watchLinks(html, kw) {
    const out = new Set();
    for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,600}?)<\/a>/g)) {
      const attrs = m[1];
      const text = m[2].replace(/<[^>]+>/g, ' ');
      const href = (attrs.match(/href="([^"]+)"/) || [])[1];
      if (!href || !href.startsWith('/') || /^\/(\?|$)/.test(href) || /^\/(products|policies|cart|account)/.test(href)) continue;
      const isButton = /button-custom|COMING SOON|預約|RESERVE|BOOK/i.test(attrs + text);
      const isKeyword = kw && kw.test(text + ' ' + attrs);
      if (isButton || isKeyword) out.add(href);
    }
    return [...out].slice(0, 5);
  }

  // 找出日期選項與時段選項的位置（option1/2/3）
  function detectOptionKeys(product) {
    const keys = ['option1', 'option2', 'option3'];
    const names = (product.options || []).map((o) => (typeof o === 'string' ? o : o.name) || '');
    let dateKey = null, timeKey = null;
    names.forEach((n, i) => {
      if (/日期|date/i.test(n)) dateKey = keys[i];
      if (/區間|時段|時間|場次|time/i.test(n)) timeKey = keys[i];
    });
    const v0 = product.variants[0] || {};
    if (!dateKey) dateKey = keys.find((k) => /\d{1,2}\s*\/\s*\d{1,2}/.test(v0[k] || ''));
    if (!timeKey) timeKey = keys.find((k) => /\d{1,2}:\d{2}/.test(v0[k] || ''));
    return { dateKey, timeKey };
  }

  function pickVariant(product, config) {
    const targetMD = parseMD(config.TARGET_DATE);
    const { dateKey, timeKey } = detectOptionKeys(product);
    if (!dateKey || !timeKey) throw new Error('無法辨識日期/時段選項');
    const minS = toMin(config.EARLIEST_START);
    const maxS = toMin(config.LATEST_START);
    const sameDay = product.variants.filter((v) => parseMD(v[dateKey]) === targetMD);
    const candidates = sameDay
      .filter((v) => v.available)
      .map((v) => ({ v, start: parseStartMin(v[timeKey]) }))
      .filter(({ start }) => start != null && (minS == null || start >= minS) && (maxS == null || start <= maxS))
      .sort((a, b) => a.start - b.start); // 越早越好
    return { found: sameDay.length > 0, pick: candidates[0]?.v || null, timeKey };
  }

  // ---------- 購物車 ----------
  class LimitError extends Error {}

  // 清空購物車；若網站的限購規則擋住清空（422），改為刪除 cart cookie 換一台新購物車
  async function clearCart() {
    const res = await fetch('/cart/clear.js', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    if (res.ok) return;
    document.cookie = 'cart=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    document.cookie = `cart=; path=/; domain=.${location.hostname}; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    const c = await (await fetch('/cart.js', { cache: 'no-store' })).json();
    if (c.item_count > 0) throw new Error('購物車無法清空，請手動處理');
  }

  async function addToCart(variantId, qty) {
    await clearCart();
    const res = await fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: [{ id: variantId, quantity: qty }] }),
    });
    const data = await res.json().catch(() => ({}));
    const msg = data.description || data.message || '';
    if (/限購/.test(msg)) throw new LimitError(msg.replace(/^[:\s]+/, ''));
    if (!res.ok) throw new Error(msg || `加入購物車失敗 HTTP ${res.status}`);
    return data;
  }

  // ---------- 點擊模式：盯首頁按鈕 ----------
  const btnPath = (a) => { try { return new URL(a.href, location.origin).pathname + new URL(a.href, location.origin).search; } catch (_) { return ''; } };
  const mainButtons = () => [...document.querySelectorAll('main a, #MainContent a')].filter((a) => /button/i.test(a.className) || /COMING SOON|BOOKING|預約|RESERVE/i.test(a.textContent));
  const btnKey = (a) => [...a.classList].find((c) => /^button-custom--/.test(c)) || a.textContent.trim();

  // 開賣前記下：哪顆按鈕還是 COMING SOON（目標）、其他按鈕當下的連結（例如 A9，永不點）
  async function recordBaseline() {
    const btns = mainButtons();
    if (!btns.length) return;
    const targets = btns.filter((a) => a.getAttribute('aria-disabled') === 'true' || !a.getAttribute('href') || /COMING SOON/i.test(a.textContent)).map(btnKey);
    const oldHrefs = btns.filter((a) => a.getAttribute('href') && a.getAttribute('aria-disabled') !== 'true').map(btnPath);
    sessionStorage.removeItem('mywayTries');
    await setState({ baseline: { targets, oldHrefs } });
    await log(`📌 已記住目標按鈕 ${targets.length} 顆（排除既有連結 ${oldHrefs.length} 個）`);
  }

  // 回傳已開放、可點擊的目標按鈕
  function findActiveButton(baseline) {
    const { targets = [], oldHrefs = [] } = baseline || {};
    for (const a of mainButtons()) {
      const href = a.getAttribute('href');
      if (!href || href === '#' || a.getAttribute('aria-disabled') === 'true') continue;
      const path = btnPath(a);
      if (path === '/' || path.startsWith('/?') || oldHrefs.includes(path)) continue;
      if (targets.includes(btnKey(a)) || !/COMING SOON/i.test(a.textContent)) return a;
    }
    return null;
  }

  // ---------- 搶位主迴圈 ----------
  let running = false;
  async function runBooking() {
    if (running) return;
    running = true;
    try {
      let { config, state } = await getState();
      const targetMD = parseMD(config.TARGET_DATE);
      if (!targetMD) { await log('❌ TARGET_DATE 格式錯誤'); return; }

      // 定時開搶
      const clickMode = String(config.CLICK_MODE ?? 'true').toLowerCase() === 'true';
      const onProductPage = location.pathname.startsWith('/products/');
      if (clickMode && !onProductPage && !state.baseline) await recordBaseline();

      const t = parseStartAt(config.START_AT, config.PRE_START_SECONDS);
      if (t) {
        const wait = t - Date.now();
        if (wait > 0) {
          await log(`⏰ 開賣 ${config.START_AT}，將於 ${t.toLocaleString()} 開始輪詢（約 ${Math.round(wait / 1000)} 秒後）`);
          while (Date.now() < t.getTime()) {
            if (!(await getState()).state.armed) return;
            await wakeableSleep(Math.max(0, Math.min(200, t - Date.now())));
          }
        }
      }

      const fixedHandle = handleFromUrl(config.PRODUCT_URL);
      let handle = fixedHandle || null; // 自動模式每次開搶都重新找商品
      if (!handle && onProductPage && state.stage === 'clicked') handle = handleFromUrl(location.pathname);
      const excluded = []; // 被限購擋下的商品，自動模式下略過
      const qty = Math.max(1, parseInt(config.QUANTITY || '1', 10));
      const interval = Math.max(500, parseInt(config.POLL_INTERVAL_MS || '1500', 10));
      let tries = +(sessionStorage.getItem('mywayTries') || 0);

      while ((await getState()).state.armed) {
        tries++;
        sessionStorage.setItem('mywayTries', tries);
        // 點擊模式：先看畫面上的按鈕，開放了就點
        if (clickMode && !onProductPage && state.stage !== 'clicked') {
          const btn = findActiveButton((await getState()).state.baseline);
          if (btn) {
            await setState({ stage: 'clicked' });
            await log(`👆 按鈕已開放，點擊「${btn.textContent.trim()}」→ ${btnPath(btn)}`);
            btn.click();
            return;
          }
        }
        banner(`${new Date().toLocaleTimeString()} 輪詢中（第 ${tries} 次）\n${handle ? '商品：' + decodeURIComponent(handle) : '等待新商品上架／按鈕開放…'}`);
        try {
          if (!handle) {
            if (tries === 1) await log(`🔍 尋找含 ${targetMD}${config.PRODUCT_KEYWORD ? `、名稱符合「${config.PRODUCT_KEYWORD}」` : ''} 的商品…`);
            handle = await discoverHandle(targetMD, excluded, config.PRODUCT_KEYWORD);
            if (handle) { await setState({ handle }); await log(`✅ 找到商品：${decodeURIComponent(handle)}`); }
          }
          if (handle) {
            const product = await fetchProduct(handle);
            const { found, pick, timeKey } = pickVariant(product, config);
            if (pick) {
              await log(`🎯 選到 ${pick.title}，加入購物車 x${qty}`);
              await addToCart(pick.id, qty);
              if (String(config.SHOW_PRODUCT_PAGE ?? 'true').toLowerCase() === 'true') {
                await setState({ stage: 'showProduct', picked: pick.title, submitted: false });
                await log('🛒 已加入，切到商品頁顯示');
                location.href = `/products/${handle}?variant=${pick.id}`;
              } else {
                await setState({ stage: 'checkout', picked: pick.title, submitted: false });
                await log('🛒 已加入，前往結帳');
                location.href = '/checkout';
              }
              return;
            }
            if (tries === 1 || tries % 10 === 0) {
              await log(found ? `⌛ ${targetMD} 目前無可預約場次，持續重試（第 ${tries} 次）` : `⌛ 商品尚無 ${targetMD} 的選項（可能超過 250 個場次上限或未上架），重試中`);
            }
          } else if (tries % 10 === 1) {
            await log('⌛ 尚未找到商品，重試中');
          }
        } catch (e) {
          // 帳號已達限購（例如已有同商品的預約）：重試也沒用，直接停止
          if (e instanceof LimitError && !fixedHandle) {
            await log(`⛔ ${decodeURIComponent(handle)} 被限購擋下（${e.message}），改找其他商品`);
            excluded.push(handle);
            handle = null;
            await sleep(interval);
            continue;
          }
          if (e instanceof LimitError) {
            await log(`⛔ 網站拒絕：${e.message}。此帳號可能已預約過此商品，請先取消舊預約或換帳號`);
            await setState({ armed: false });
            return;
          }
          await log(`⚠️ ${e.message || e}`);
        }
        await sleep(interval);
        // 點擊模式：非商品頁就重新整理，讓畫面上的按鈕更新
        if (clickMode && !onProductPage && !handle && (await getState()).state.armed) {
          location.reload();
          return;
        }
      }
      await log('⏹ 已停止');
    } finally {
      running = false;
    }
  }

  // ---------- 結帳頁填寫 ----------
  function setNativeValue(el, value) {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype
      : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }
  // 排除 Shopify 的隱藏 autofill_* 欄位，只認真正看得到的輸入框
  const visible = (el) => {
    if (!el || el.disabled || el.offsetParent === null || /^autofill_/.test(el.id)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const qsaVisible = (sel) => [...document.querySelectorAll(sel)].filter(visible);

  async function waitFor(fn, timeout = 20000, step = 200) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const r = fn();
      if (r) return r;
      await sleep(step);
    }
    return null;
  }

  function fillField(names, value) {
    if (!value) return 0;
    const sel = names.map((n) => `input[name="${n}"], input[autocomplete="${n}"]`).join(',');
    let count = 0;
    for (const el of qsaVisible(sel)) {
      if (el.value !== value) { setNativeValue(el, value); }
      count++;
    }
    return count;
  }

  function findPayButton() {
    const byId = document.querySelector('#checkout-pay-button');
    if (visible(byId)) return byId;
    return qsaVisible('button[type="submit"], button').find((b) => /完成訂單|立即付款|Complete order|Pay now/i.test(b.textContent));
  }

  async function runCheckout() {
    const { config, state } = await getState();
    if (!state.armed || state.stage !== 'checkout' || state.submitted) return;
    await log(`📝 結帳頁：開始填寫帳單資料（${state.picked || ''}）`);

    // 等表單出現
    await waitFor(() => qsaVisible('input[name="firstName"], input[name="lastName"], input[name="address1"]').length > 0 || findPayButton());

    // 若有「取貨」選項就點選
    const pickup = qsaVisible('input[type="radio"]').find((r) => /PICK_UP|pickup|取貨/i.test(r.value + (r.closest('label')?.textContent || '')));
    if (pickup && !pickup.checked) { pickup.click(); await sleep(600); }

    fillField(['email'], config.EMAIL);
    const country = qsaVisible('select[name="countryCode"], select[autocomplete$="country"]');
    for (const s of country) if (config.COUNTRY_CODE && s.value !== config.COUNTRY_CODE) { setNativeValue(s, config.COUNTRY_CODE); await sleep(500); }

    fillField(['firstName', 'given-name'], config.FIRST_NAME);
    fillField(['lastName', 'family-name'], config.LAST_NAME);
    fillField(['address1'], config.ADDRESS1);
    fillField(['address2'], config.ADDRESS2);
    fillField(['city'], config.CITY);
    fillField(['postalCode', 'postal-code'], config.POSTAL_CODE);
    fillField(['phone', 'tel'], config.PHONE);
    await sleep(800);

    // 檢查必填是否都填了
    const empty = qsaVisible('input[name="firstName"], input[name="lastName"], input[name="address1"], input[name="city"]').filter((el) => !el.value);
    if (empty.length) await log(`⚠️ 仍有 ${empty.length} 個必填欄位空白，請確認 .env`);

    // popup 勾選框優先，沒設定過才看 .env
    const { autoComplete } = await chrome.storage.local.get('autoComplete');
    const auto = autoComplete ?? String(config.AUTO_COMPLETE_ORDER).toLowerCase() === 'true';
    if (!auto) {
      await log('✋ 已填完資料，未勾選「自動按完成訂單」，請手動按「完成訂單」');
      await setState({ armed: false });
      return;
    }

    const btn = await waitFor(() => { const b = findPayButton(); return b && !b.disabled ? b : null; }, 15000);
    if (!btn) { await log('❌ 找不到「完成訂單」按鈕，請手動按'); return; }
    await setState({ submitted: true });
    btn.click();
    await log('🚀 已按下「完成訂單」');

    // 若出現錯誤訊息，允許再試一次
    await sleep(4000);
    const err = qsaVisible('[role="alert"], .notice--error, [id^="error-for"]').map((e) => e.textContent.trim()).filter(Boolean);
    if (err.length && /\/checkouts?\b/.test(location.pathname)) {
      await log(`⚠️ 結帳頁訊息：${err.join(' / ').slice(0, 200)}`);
      await setState({ submitted: false });
    }
  }

  // ---------- 感謝頁偵測 ----------
  async function checkThankYou() {
    if (/thank[_-]?you|orders\//i.test(location.pathname) || /訂單已確認|感謝您|Thank you/i.test(document.title)) {
      const { state } = await getState();
      if (state.armed) {
        await log(`🎉 預約完成！${state.picked || ''}`);
        await setState({ armed: false, stage: 'done' });
      }
      return true;
    }
    return false;
  }

  // ---------- 進入點 ----------
  async function main() {
    const { state } = await getState();
    // 被導到會員登入頁：提示使用者登入，登入後 Shopify 會自動導回結帳頁繼續
    if (location.hostname.startsWith('account.')) {
      if (state.armed && /login|authentication/i.test(location.pathname)) {
        await log('🔐 需要登入會員！請立即完成登入，登入後會自動回到結帳頁繼續');
      }
      return;
    }
    if (await checkThankYou()) return;
    if (!state.armed) return;
    if (isCheckout()) runCheckout();
    else if (state.stage === 'showProduct') {
      // 商品頁停留一下讓使用者看到場次，再進結帳
      const { config } = await getState();
      await log(`👀 已選：${state.picked || ''}，${Math.round((+config.SHOW_PRODUCT_MS || 1000) / 100) / 10} 秒後進結帳`);
      await sleep(Math.max(0, +config.SHOW_PRODUCT_MS || 1000));
      await setState({ stage: 'checkout' });
      location.href = '/checkout';
    }
    else if (state.stage !== 'checkout') runBooking();
    else {
      // stage=checkout 但卻不在結帳頁（可能被導回），重新搶
      await setState({ stage: 'booking' });
      runBooking();
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'start') { wakeAll(); main(); }
  });
  main();
})();
