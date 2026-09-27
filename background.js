// 讀取插件資料夾內的 .env，解析後存進 chrome.storage.local.config
async function loadEnv() {
  const res = await fetch(chrome.runtime.getURL('.env'), { cache: 'no-store' });
  if (!res.ok) throw new Error('找不到 .env（請由 .env.example 複製一份）');
  const text = await res.text();
  const config = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // 去掉前後引號
    if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    config[key] = val;
  }
  await chrome.storage.local.set({ config });
  return config;
}

chrome.runtime.onInstalled.addListener(() => loadEnv().catch(console.error));
chrome.runtime.onStartup.addListener(() => loadEnv().catch(console.error));

// 喚醒所有 mywaygoods 分頁的內容腳本
async function pokeTabs() {
  const tabs = await chrome.tabs.query({ url: ['https://mywaygoods.com/*', 'https://*.myshopify.com/*'] });
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'start' }).catch(() => {});
}

// 開賣前 60 秒、10 秒各喚醒一次分頁（避免背景分頁計時器被 Chrome 降速而晚起跑）
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('wake')) return;
  const { state = {} } = await chrome.storage.local.get('state');
  if (state.armed) pokeTabs();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'scheduleWake') {
    chrome.alarms.clearAll().then(() => {
      if (msg.at) {
        for (const sec of [60, 15]) {
          const when = msg.at - sec * 1000;
          if (when > Date.now()) chrome.alarms.create(`wake${sec}`, { when });
        }
      }
      pokeTabs();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg?.type === 'stop') {
    chrome.alarms.clearAll().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'reloadEnv') {
    loadEnv()
      .then((config) => sendResponse({ ok: true, config }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // 非同步回應
  }
});
