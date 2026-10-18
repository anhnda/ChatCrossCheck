const DEFAULTS = {
  maxTurns: 3,
  endAt: 'chatgpt',
  delaySec: 5,
  timeoutMin: 10,
  totalTimeoutMin: 0,
  useAgree: false,
  stopGen: false,
  problem: '',
  tplToClaude:
    'Dưới đây là phản hồi của một chatbot AI khác (ChatGPT) cho bài toán/vấn đề đang xét. ' +
    'Hãy đóng vai người phản biện: kiểm tra độ chính xác từng bước, chỉ ra lỗi sai hoặc chỗ thiếu chặt chẽ (nếu có), ' +
    'nêu rõ bạn đồng ý / không đồng ý ở điểm nào và vì sao, rồi đưa ra phiên bản sửa nếu cần.\n' +
    '{{problem}}\n===== PHẢN HỒI CỦA CHATGPT =====\n{{content}}',
  tplToChatGPT:
    'Dưới đây là phản hồi của một chatbot AI khác (Claude) về lời giải/đề xuất của bạn. ' +
    'Hãy đánh giá nghiêm túc từng điểm Claude nêu: điểm nào đúng thì chấp nhận, điểm nào sai thì phản bác có lý lẽ, ' +
    'rồi đưa ra phiên bản cuối cùng đã được kiểm chứng.\n\n===== PHẢN HỒI CỦA CLAUDE =====\n{{content}}',
};

const $ = (id) => document.getElementById(id);
const FIELDS = ['maxTurns', 'endAt', 'delaySec', 'timeoutMin', 'totalTimeoutMin', 'useAgree', 'stopGen', 'problem', 'tplToClaude', 'tplToChatGPT'];
const STATUS_TEXT = {
  idle: 'Chưa chạy',
  running: 'Đang chạy',
  paused: 'Tạm dừng',
  finished: 'Hoàn tất',
  error: 'Lỗi',
};

// ----------------------------------------------------------- settings
function readSettings() {
  const s = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') s[f] = el.checked;
    else if (el.type === 'number') {
      const n = Number(el.value);
      s[f] = el.value === '' || Number.isNaN(n) ? DEFAULTS[f] : n; // cho phép 0
    }
    else s[f] = el.value;
  }
  return s;
}

function writeSettings(s) {
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = !!s[f];
    else el.value = s[f];
  }
}

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  writeSettings({ ...DEFAULTS, ...(settings || {}) });
}

function saveSettings() {
  chrome.storage.local.set({ settings: readSettings() });
}

// ---------------------------------------------------------------- render
function hostOf(url) {
  try { return new URL(url).hostname; } catch (_) { return ''; }
}

function render(state) {
  const s = state || { status: 'idle', tabs: {}, log: [] };
  for (const k of ['chatgpt', 'claude']) {
    const t = s.tabs && s.tabs[k];
    $('t-' + k).textContent = t ? `${t.title || '(không tiêu đề)'} · ${hostOf(t.url)}` : 'chưa gán';
  }

  const running = s.status === 'running';
  $('startGpt').disabled = running;
  $('startClaude').disabled = running;
  $('stop').disabled = !running;

  // đồng bộ ô ghi chú khi background đã dùng xong (chỉ khi người dùng không đang gõ)
  const noteEl = $('nextNote');
  if (document.activeElement !== noteEl && (s.nextNote || '') !== noteEl.value) {
    noteEl.value = s.nextNote || '';
  }
  for (const k of ['chatgpt', 'claude']) $('a-' + k).disabled = running;

  const st = $('status');
  st.className = 'status ' + s.status;
  st.textContent = (STATUS_TEXT[s.status] || s.status) + (s.note ? ' — ' + s.note : '');

  const total = s.totalSteps || 0;
  const src = s.source === 'claude' ? 'Claude' : 'ChatGPT';
  $('progress').textContent = running
    ? `Bước ${s.stepsDone + 1}/${total} (bắt đầu từ ${src}) · đang chờ ${s.step === 'claude' ? 'Claude' : 'ChatGPT'} trả lời` +
      (s.deadline ? ` · hết hạn lúc ${new Date(s.deadline).toLocaleTimeString()}` : '')
    : s.stepsDone ? `Đã xong ${s.stepsDone}/${total} bước` : '';

  const ol = $('log');
  ol.innerHTML = '';
  [...(s.log || [])].reverse().forEach((e) => {
    const li = document.createElement('li');
    const time = new Date(e.t).toLocaleTimeString();
    const who = document.createElement('span');
    who.className = 'who ' + e.who;
    who.textContent = e.who === 'claude' ? 'Claude' : 'ChatGPT';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${time} · ${e.len} ký tự${e.tag ? ' · ' + e.tag : ''}`;
    const pv = document.createElement('div');
    pv.textContent = e.preview + (e.len > e.preview.length ? '…' : '');
    li.append(who, meta, pv);
    ol.append(li);
  });
}

async function refresh() {
  const { state } = await chrome.storage.session.get('state');
  render(state);
}

// ---------------------------------------------------------------- events
async function assign(site) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  await chrome.runtime.sendMessage({
    type: 'assign',
    site,
    tab: { id: tab.id, url: tab.url, title: tab.title },
  });
}

$('a-chatgpt').onclick = () => assign('chatgpt');
$('a-claude').onclick = () => assign('claude');
async function startFrom(source) {
  saveSettings();
  await chrome.runtime.sendMessage({ type: 'setNote', note: $('nextNote').value });
  await chrome.runtime.sendMessage({ type: 'start', settings: readSettings(), source });
}
$('startGpt').onclick = () => startFrom('chatgpt');
$('startClaude').onclick = () => startFrom('claude');
$('nextNote').addEventListener('input', () =>
  chrome.runtime.sendMessage({ type: 'setNote', note: $('nextNote').value })
);
$('stop').onclick = () => chrome.runtime.sendMessage({ type: 'stop' });
$('resetTpl').onclick = () => {
  $('tplToClaude').value = DEFAULTS.tplToClaude;
  $('tplToChatGPT').value = DEFAULTS.tplToChatGPT;
  saveSettings();
};
FIELDS.forEach((f) => $(f).addEventListener('change', saveSettings));

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.state) render(changes.state.newValue);
});

(async () => {
  await loadSettings();
  await chrome.runtime.sendMessage({ type: 'autoDetect' });
  await refresh();
})();
