// Service worker: bộ điều phối (state machine) giữa tab ChatGPT và tab Claude.
// Chạy theo sự kiện, state lưu ở chrome.storage.session nên sống sót khi worker bị suspend.

const URL_PATTERNS = [
  'https://claude.ai/*',
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
];

const DEFAULT_STATE = {
  status: 'idle', // idle | running | paused | finished | error
  note: '',
  tabs: { chatgpt: null, claude: null }, // {id, title, url}
  runId: 0,
  source: null, // bên nguồn của lần Bắt đầu hiện tại
  stepsDone: 0, // số lần chuyển đã hoàn tất trong lần chạy này
  totalSteps: 0, // tổng số lần chuyển cần thực hiện
  nextNote: '', // ghi chú của người dùng, chèn vào đúng 1 lần chuyển kế tiếp
  deadline: 0, // mốc thời gian (ms) hết hạn của cả lần chạy; 0 = không giới hạn
  step: null, // 'claude' | 'chatgpt' — bên sắp được gửi tới
  pendingText: '',
  prevAgree: false,
  awaiting: false,
  settings: null,
  log: [],
};

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ----------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getState() {
  const { state } = await chrome.storage.session.get('state');
  return { ...DEFAULT_STATE, ...(state || {}) };
}
async function setState(patch) {
  const s = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ state: s });
  return s;
}

function siteOf(url) {
  try {
    const h = new URL(url).hostname;
    if (h === 'claude.ai') return 'claude';
    if (h === 'chatgpt.com' || h === 'chat.openai.com') return 'chatgpt';
  } catch (_) {}
  return null;
}

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    return null;
  }
}

let keepAliveTimer = null;
function keepAlive(on) {
  if (on && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  } else if (!on && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// Timeout tổng cho cả lần chạy (khác với timeout từng lượt trả lời nằm ở content script)
let deadlineTimer = null;
function scheduleDeadline(s) {
  clearTimeout(deadlineTimer);
  deadlineTimer = null;
  if (!s.deadline || s.status !== 'running') return;
  deadlineTimer = setTimeout(
    () => timeoutRun(s.runId),
    Math.max(0, Math.min(s.deadline - Date.now(), 2147000000))
  );
}

async function timeoutRun(runId) {
  const s = await getState();
  if (s.runId !== runId || s.status !== 'running') return;
  const mins = s.settings ? s.settings.totalTimeoutMin : '';
  await finish('paused', `Hết thời gian tổng (${mins} phút) — đã tạm dừng, có thể chạy tiếp.`);
  const stopGen = !!(s.settings && s.settings.stopGen);
  for (const k of ['claude', 'chatgpt']) {
    if (s.tabs[k]) sendToTab(s.tabs[k].id, { type: 'cancel', stopGeneration: stopGen });
  }
}

const SITE_NAME = { claude: 'Claude', chatgpt: 'ChatGPT' };

// --------------------------------------------------------- tab assignment
async function assignTab(site, tab) {
  if (siteOf(tab.url) !== site) {
    await setState({ note: `Tab này không phải ${SITE_NAME[site]}.` });
    return;
  }
  const s = await getState();
  await setState({
    tabs: { ...s.tabs, [site]: { id: tab.id, title: tab.title || '', url: tab.url } },
    note: '',
  });
}

async function autoDetect() {
  const tabs = await chrome.tabs.query({ url: URL_PATTERNS });
  const by = { claude: [], chatgpt: [] };
  tabs.forEach((t) => {
    const k = siteOf(t.url);
    if (k) by[k].push(t);
  });
  const s = await getState();
  const next = { ...s.tabs };
  for (const k of ['claude', 'chatgpt']) {
    if (!next[k] && by[k].length === 1) {
      const t = by[k][0];
      next[k] = { id: t.id, title: t.title || '', url: t.url };
    }
  }
  await setState({ tabs: next });
}

// ----------------------------------------------------------- templates
function agreeSuffix(name) {
  return (
    '\n\nQuy ước kết thúc: dòng cuối cùng của câu trả lời phải là đúng một trong hai thẻ — ' +
    '[AGREE] nếu bạn đồng ý hoàn toàn với kết luận cuối cùng hiện tại, hoặc ' +
    '[DISAGREE] nếu vẫn còn điểm bất đồng.'
  );
}

function buildMessage(s) {
  const st = s.settings;
  const toClaude = s.step === 'claude';
  const tpl = toClaude ? st.tplToClaude : st.tplToChatGPT;
  const isFirst = s.stepsDone === 0 && toClaude; // đề bài chỉ kèm ở bước đầu của mỗi lần Bắt đầu
  const problem =
    isFirst && st.problem && st.problem.trim()
      ? `\n===== ĐỀ BÀI GỐC =====\n${st.problem.trim()}\n`
      : '';
  // dùng hàm thay thế để ký tự đặc biệt ($&, $1...) trong nội dung không bị diễn giải
  let msg = tpl.replace('{{problem}}', () => problem).replace('{{content}}', () => s.pendingText);
  if (!tpl.includes('{{content}}')) msg += '\n\n' + s.pendingText;
  if (st.useAgree) msg += agreeSuffix();
  if (s.nextNote && s.nextNote.trim()) {
    msg = `[Ghi chú của người dùng cho lượt này]\n${s.nextNote.trim()}\n\n` + msg;
  }
  return msg;
}

function detectAgree(text) {
  const tail = text.slice(-200);
  return /\[AGREE\]/i.test(tail) && !/\[DISAGREE\]/i.test(tail);
}
const stripAgree = (t) => t.replace(/^\s*\[(?:DIS)?AGREE\]\s*$/gim, '').trim();

// -------------------------------------------------------------- run loop
async function finish(status, note) {
  keepAlive(false);
  clearTimeout(deadlineTimer);
  await setState({ status, note, awaiting: false });
}

async function fail(note) {
  const s = await getState();
  for (const k of ['claude', 'chatgpt']) {
    if (s.tabs[k]) sendToTab(s.tabs[k].id, { type: 'cancel', stopGeneration: false });
  }
  await finish('error', note);
}

// source: bên có câu trả lời mới nhất sẽ được chuyển sang bên còn lại
async function startRun(settings, source) {
  let s = await getState();
  if (s.status === 'running') return;
  if (source !== 'chatgpt' && source !== 'claude') return;
  const target = source === 'chatgpt' ? 'claude' : 'chatgpt';

  // 1) kiểm tra tab
  for (const k of ['chatgpt', 'claude']) {
    const t = s.tabs[k];
    if (!t) return setState({ status: 'error', note: `Chưa gán tab ${SITE_NAME[k]}.` });
    let tab;
    try {
      tab = await chrome.tabs.get(t.id);
    } catch (_) {
      return setState({ status: 'error', note: `Tab ${SITE_NAME[k]} đã bị đóng. Hãy gán lại.` });
    }
    if (siteOf(tab.url) !== k) {
      return setState({ status: 'error', note: `Tab ${SITE_NAME[k]} không còn ở đúng trang.` });
    }
    const pong = await sendToTab(t.id, { type: 'ping' });
    if (!pong || !pong.ok) {
      return setState({
        status: 'error',
        note: `Tab ${SITE_NAME[k]} chưa nạp extension — hãy tải lại (F5) tab đó rồi thử lại.`,
      });
    }
  }

  // 2) lấy câu trả lời cuối cùng (đã hoàn tất) của bên nguồn
  const last = await sendToTab(s.tabs[source].id, { type: 'readLast' });
  if (!last || !last.ok) {
    return setState({
      status: 'error',
      note: (last && last.error) || `Không đọc được ${SITE_NAME[source]}.`,
    });
  }
  if (!last.complete) {
    return setState({
      status: 'error',
      note: `${SITE_NAME[source]} chưa trả lời xong — hãy chờ xong rồi bấm Bắt đầu.`,
    });
  }
  if (!last.text) {
    return setState({ status: 'error', note: `Câu trả lời cuối của ${SITE_NAME[source]} đang rỗng.` });
  }

  // 3) tính số lần chuyển để kết thúc đúng ở bên endAt sau N lần bên đó trả lời
  const N = Math.max(1, settings.maxTurns | 0);
  const endAt = settings.endAt === 'claude' ? 'claude' : 'chatgpt';
  const totalSteps = endAt === target ? 2 * N - 1 : 2 * N;

  const runId = Date.now();
  const totalMin = Math.max(0, Number(settings.totalTimeoutMin) || 0);
  const deadline = totalMin > 0 ? runId + totalMin * 60000 : 0;
  await setState({
    status: 'running',
    note: '',
    runId,
    deadline,
    source,
    stepsDone: 0,
    totalSteps,
    step: target,
    pendingText: stripAgree(last.text),
    prevAgree: detectAgree(last.text),
    awaiting: false,
    settings,
    log: [...s.log, logEntry(source, last.text, 'điểm bắt đầu')].slice(-60),
  });
  keepAlive(true);
  scheduleDeadline(await getState());
  await dispatch(runId);
}

function logEntry(who, text, tag) {
  return { t: Date.now(), who, len: text.length, preview: text.slice(0, 140), tag: tag || '' };
}

// Gửi nội dung đang chờ sang bên `step`, sau khi delay
async function dispatch(runId) {
  let s = await getState();
  if (s.runId !== runId || s.status !== 'running') return;

  await sleep(Math.max(0, s.settings.delaySec) * 1000);

  s = await getState();
  if (s.runId !== runId || s.status !== 'running') return; // đã bị Stop trong lúc chờ
  if (s.deadline && Date.now() >= s.deadline) return timeoutRun(runId);

  const target = s.tabs[s.step];
  if (!target) return fail(`Mất tab ${SITE_NAME[s.step]}.`);

  const text = buildMessage(s);
  await setState({ awaiting: true, nextNote: '' }); // ghi chú chỉ dùng 1 lần
  const ack = await sendToTab(target.id, {
    type: 'run',
    runId,
    text,
    timeoutMs: Math.max(1, s.settings.timeoutMin) * 60000,
  });
  if (!ack || !ack.ok) {
    return fail(
      `Không gửi được sang ${SITE_NAME[s.step]}: ${(ack && ack.error) || 'tab không phản hồi (thử tải lại tab).'}`
    );
  }
}

async function onDone(msg) {
  const s = await getState();
  if (s.runId !== msg.runId || s.status !== 'running') return;
  if (!msg.ok) return fail(`${SITE_NAME[s.step]}: ${msg.error}`);

  const who = s.step;
  const agree = detectAgree(msg.text);
  const log = [...s.log, logEntry(who, msg.text, agree ? 'AGREE' : '')].slice(-60);
  const clean = stripAgree(msg.text);

  const stepsDone = s.stepsDone + 1;
  const endAt = s.settings.endAt === 'claude' ? 'claude' : 'chatgpt';

  // đồng thuận: chỉ dừng khi bên vừa trả lời cũng là bên kết thúc đã chọn
  if (s.settings.useAgree && agree && s.prevAgree && who === endAt) {
    await setState({ log, stepsDone, pendingText: clean });
    return finish('finished', 'Hai bên đã đồng thuận ([AGREE]).');
  }
  if (stepsDone >= s.totalSteps) {
    await setState({ log, stepsDone, pendingText: clean });
    return finish('finished', `Hoàn tất ${stepsDone} lần chuyển (kết thúc ở ${SITE_NAME[who]}).`);
  }

  await setState({
    log,
    stepsDone,
    step: who === 'claude' ? 'chatgpt' : 'claude',
    pendingText: clean,
    prevAgree: agree,
    awaiting: false,
  });
  await dispatch(s.runId);
}

async function stopRun() {
  const s = await getState();
  if (s.status !== 'running') return;
  await finish('paused', 'Đã tạm dừng — bạn có thể tự nhắn ở các tab, rồi chọn bên nguồn để chạy tiếp.');
  const stopGen = !!(s.settings && s.settings.stopGen);
  for (const k of ['claude', 'chatgpt']) {
    if (s.tabs[k]) sendToTab(s.tabs[k].id, { type: 'cancel', stopGeneration: stopGen });
  }
}

// ------------------------------------------------------------- listeners
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'assign': await assignTab(msg.site, msg.tab); break;
      case 'autoDetect': await autoDetect(); break;
      case 'start': await startRun(msg.settings, msg.source); break;
      case 'setNote': await setState({ nextNote: msg.note || '' }); break;
      case 'stop': await stopRun(); break;
      case 'done': await onDone(msg); break;
    }
    sendResponse({ ok: true });
  })();
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getState();
  const k = ['chatgpt', 'claude'].find((x) => s.tabs[x] && s.tabs[x].id === tabId);
  if (!k) return;
  if (s.status === 'running') {
    await fail(`Tab ${SITE_NAME[k]} đã bị đóng.`);
  }
  const s2 = await getState();
  await setState({ tabs: { ...s2.tabs, [k]: null } });
});

// Cập nhật tiêu đề/URL tab đã gán (chat mới đổi /new -> /chat/<id> vẫn hợp lệ)
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!info.title && !info.url) return;
  const s = await getState();
  const k = ['chatgpt', 'claude'].find((x) => s.tabs[x] && s.tabs[x].id === tabId);
  if (!k) return;
  if (siteOf(tab.url) !== k) {
    if (s.status === 'running') await fail(`Tab ${SITE_NAME[k]} đã chuyển sang trang khác.`);
    return;
  }
  await setState({ tabs: { ...s.tabs, [k]: { id: tabId, title: tab.title || '', url: tab.url } } });
});

// Nếu worker khởi động lại giữa lúc đang chạy: tiếp tục nhịp phù hợp
(async () => {
  const s = await getState();
  if (s.status === 'running') {
    keepAlive(true);
    scheduleDeadline(s);
    if (!s.awaiting) dispatch(s.runId);
  }
})();
