const $ = (id) => document.getElementById(id);

// 與 content.js 相同的 START_AT 解析
function parseStartAt(startAt, preSec) {
  if (!startAt) return null;
  const m = String(startAt).trim().match(/^(?:(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T]+)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const t = new Date();
  if (m[1]) t.setFullYear(+m[1], +m[2] - 1, +m[3]);
  t.setHours(+m[4], +m[5], +(m[6] || 0), 0);
  return new Date(t.getTime() - Math.max(0, parseFloat(preSec || '0')) * 1000);
}

async function render() {
  const { config = {}, state = {}, logs = [], autoComplete } = await chrome.storage.local.get(['config', 'state', 'logs', 'autoComplete']);
  // 未設定過勾選框時，沿用 .env 的 AUTO_COMPLETE_ORDER
  $('autoComplete').checked = autoComplete ?? String(config.AUTO_COMPLETE_ORDER).toLowerCase() === 'true';
  const t = parseStartAt(config.START_AT, config.PRE_START_SECONDS);
  const left = t ? Math.round((t - Date.now()) / 1000) : null;
  $('status').textContent = state.armed
    ? `🟢 執行中｜階段：${state.stage || 'booking'}${left > 0 ? `｜${left} 秒後開始輪詢` : ''}`
    : `⚪ 未啟動${state.stage === 'done' ? '（上次已完成）' : ''}`;
  $('cfg').textContent =
    `日期 ${config.TARGET_DATE || '-'}｜數量 ${config.QUANTITY || 1}｜輪詢 ${config.POLL_INTERVAL_MS || 1000}ms\n` +
    `開賣 ${config.START_AT || '立即'}（提前 ${config.PRE_START_SECONDS || 0}s）\n` +
    `帳單 ${config.LAST_NAME || '?'}${config.FIRST_NAME || '?'}｜${config.CITY || ''}${config.ADDRESS1 || '(未填地址)'}`;
  $('logs').textContent = logs.join('\n');
  $('logs').scrollTop = 1e9;
}

$('start').onclick = async () => {
  const { config = {} } = await chrome.storage.local.get('config');
  await chrome.storage.local.set({ state: { armed: true, stage: 'booking', submitted: false } });
  const t = parseStartAt(config.START_AT, config.PRE_START_SECONDS);
  await chrome.runtime.sendMessage({ type: 'scheduleWake', at: t ? t.getTime() : null });
  const tabs = await chrome.tabs.query({ url: 'https://mywaygoods.com/*' });
  if (!tabs.length) await chrome.tabs.create({ url: 'https://mywaygoods.com/' });
  render();
};

$('stop').onclick = async () => {
  const { state = {} } = await chrome.storage.local.get('state');
  await chrome.storage.local.set({ state: { ...state, armed: false } });
  await chrome.runtime.sendMessage({ type: 'stop' });
  render();
};

$('reload').onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: 'reloadEnv' });
  if (!r?.ok) alert(r?.error || '載入失敗');
  render();
};

$('autoComplete').onchange = (e) => chrome.storage.local.set({ autoComplete: e.target.checked });

$('clearLog').onclick = async () => { await chrome.storage.local.set({ logs: [] }); render(); };

chrome.storage.onChanged.addListener(render);
setInterval(render, 1000);
render();
