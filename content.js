// Content script chạy trên cả claude.ai và chatgpt.com.
// Nhiệm vụ: đọc câu trả lời cuối, nhập + gửi tin nhắn, phát hiện "đã trả lời xong".
// Toàn bộ selector nằm trong CFG bên dưới — nếu site đổi UI chỉ cần sửa ở đây.
(() => {
  if (window.__ccLoaded) return;
  window.__ccLoaded = true;

  const SITE = location.hostname.includes('claude.ai') ? 'claude' : 'chatgpt';
  const SETTLE_MS = 1200; // chờ text ổn định sau khi thanh action xuất hiện

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- CONFIG
  const CFG = {
    claude: {
      // mỗi câu trả lời của trợ lý
      messages: '[data-testid="assistant-message"]',
      id: (el) => el.getAttribute('data-turn-key'),
      // vùng chứa cả thanh action (copy / read aloud / like / dislike / retry)
      scope: (el) =>
        el.closest('[data-transcript-row]') || el.parentElement?.parentElement || el,
      doneBar:
        '[data-testid="action-bar-retry"], [data-testid="action-bar-read-aloud"], button[aria-label="Retry"]',
      streaming: (el) => el.getAttribute('data-is-streaming') === 'true',
      // phần thân nội dung (nếu không có thì lấy cả el)
      body: (el) => {
        const b = $$('.font-claude-response', el);
        return b.length ? b : [el];
      },
      composer: ['[data-testid="chat-input"]', 'div.ProseMirror[contenteditable="true"]'],
      send: ['[data-testid="chat-input-send"]', 'button[aria-label="Send message"]'],
      stop: ['button[aria-label="Stop response"]', 'button[aria-label*="Stop"]'],
    },
    chatgpt: {
      messages: '[data-dil-message-id]',
      id: (el) => el.getAttribute('data-dil-message-id'),
      scope: (el) => el.closest('[data-turn-key]') || el.parentElement,
      doneBar: 'button[aria-label="Regenerate response"], button[aria-label="Read aloud"]',
      streaming: (el) => {
        const st = (el.closest('[data-turn-key]') || document).querySelector(
          '[data-talvt-turn-state]'
        );
        return !!st && st.getAttribute('data-talvt-turn-state') !== 'complete';
      },
      body: (el) => [el],
      composer: [
        '#prompt-textarea',
        'div.ProseMirror[contenteditable="true"]',
        '[contenteditable="true"][aria-label*="ChatGPT"]',
      ],
      send: [
        '[data-testid="send-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send message"]',
      ],
      stop: [
        '[data-testid="stop-button"]',
        'button[aria-label="Stop streaming"]',
        'button[aria-label*="Stop"]',
      ],
    },
  };
  const C = CFG[SITE];

  // ------------------------------------------------------ HTML -> Markdown
  const SKIP_TAGS = new Set([
    'script', 'style', 'svg', 'button', 'noscript', 'textarea', 'input', 'select',
  ]);
  const BLOCK_TAGS = new Set([
    'div', 'section', 'article', 'header', 'footer', 'figure', 'details', 'summary',
  ]);

  function mdInline(node, ctx) {
    let s = '';
    node.childNodes.forEach((c) => (s += mdNode(c, ctx)));
    return s;
  }

  function mdNode(n, ctx) {
    if (n.nodeType === 3) return ctx.pre ? n.textContent : n.textContent.replace(/\s+/g, ' ');
    if (n.nodeType !== 1) return '';
    const tag = n.tagName.toLowerCase();

    // Công thức KaTeX: lấy LaTeX gốc từ <annotation>
    if (n.classList.contains('katex')) {
      const a = n.querySelector('annotation[encoding="application/x-tex"]');
      const tex = (a ? a.textContent : n.textContent).trim();
      return n.closest('.katex-display') ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
    }
    if (SKIP_TAGS.has(tag) || n.getAttribute('role') === 'button') return '';
    if (n.classList.contains('sr-only')) return '';

    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return `\n\n${'#'.repeat(+tag[1])} ${mdInline(n, ctx).trim()}\n\n`;
      case 'p':
        return `\n\n${mdInline(n, ctx).trim()}\n\n`;
      case 'br':
        return '\n';
      case 'hr':
        return '\n\n---\n\n';
      case 'strong': case 'b':
        return `**${mdInline(n, ctx).trim()}**`;
      case 'em': case 'i':
        return `*${mdInline(n, ctx).trim()}*`;
      case 'del': case 's':
        return `~~${mdInline(n, ctx).trim()}~~`;
      case 'code': {
        const t = n.textContent;
        return t.includes('`') ? `\`\` ${t} \`\`` : `\`${t}\``;
      }
      case 'pre': {
        const code = n.querySelector('code');
        const m = code && (code.className || '').match(/language-([\w+#-]+)/);
        const text = (code || n).textContent.replace(/\n$/, '');
        return `\n\n\`\`\`${m ? m[1] : ''}\n${text}\n\`\`\`\n\n`;
      }
      case 'a': {
        const t = mdInline(n, ctx).trim();
        const href = n.getAttribute('href');
        return href && t && !href.startsWith('javascript') ? `[${t}](${href})` : t;
      }
      case 'blockquote':
        return (
          '\n\n' +
          mdInline(n, ctx).trim().split('\n').map((l) => '> ' + l).join('\n') +
          '\n\n'
        );
      case 'ul': case 'ol': {
        let i = 0;
        const items = [...n.children]
          .filter((c) => c.tagName === 'LI')
          .map((li) => {
            i++;
            const bullet = tag === 'ol' ? `${i}. ` : '- ';
            let body = mdInline(li, ctx).trim();
            body = body.replace(/\n\n(?=\s*(?:[-*]|\d+\.)\s)/g, '\n');
            body = body.replace(/\n/g, '\n' + ' '.repeat(bullet.length));
            return bullet + body;
          });
        return '\n\n' + items.join('\n') + '\n\n';
      }
      case 'table': {
        const rows = $$('tr', n).map((tr) =>
          [...tr.children].map((c) =>
            mdInline(c, ctx).trim().replace(/\|/g, '\\|').replace(/\n+/g, ' ')
          )
        );
        if (!rows.length) return '';
        const line = (r) => '| ' + r.join(' | ') + ' |';
        const out = [line(rows[0]), line(Array(rows[0].length).fill('---')), ...rows.slice(1).map(line)];
        return '\n\n' + out.join('\n') + '\n\n';
      }
      default:
        if (BLOCK_TAGS.has(tag)) return `\n${mdInline(n, ctx)}\n`;
        return mdInline(n, ctx);
    }
  }

  function toMd(root) {
    return mdNode(root, { pre: false })
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ------------------------------------------------------- Đọc trạng thái
  function lastMsg() {
    const list = $$(C.messages);
    if (!list.length) return null;
    const el = list[list.length - 1];
    return { el, id: C.id(el) || 'idx' + list.length };
  }

  // "Hoàn thành" = không còn streaming VÀ thanh action đã hiện ở lượt đó
  function isComplete(m) {
    if (C.streaming(m.el)) return false;
    return !!$(C.doneBar, C.scope(m.el));
  }

  function extract(m) {
    return C.body(m.el).map(toMd).filter(Boolean).join('\n\n').trim();
  }

  const findFirst = (sels) => {
    for (const s of sels) {
      const e = $(s);
      if (e) return e;
    }
    return null;
  };
  const findComposer = () => findFirst(C.composer);
  const findStop = () => findFirst(C.stop);
  function findSend() {
    const b = findFirst(C.send);
    if (b) return b;
    const comp = findComposer();
    const form = comp && comp.closest('form');
    return form ? $('button[type="submit"]', form) : null;
  }
  const enabled = (b) => !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
  const composerText = (el) => (el.innerText || el.value || '').replace(/​/g, '').trim();

  // ------------------------------------------------------- Nhập + gửi
  async function setComposer(text) {
    const el = findComposer();
    if (!el) throw new Error('Không tìm thấy ô nhập tin nhắn');
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(150);

    // Paste giả lập: giữ nguyên xuống dòng, ProseMirror xử lý tốt hơn gán textContent
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    );

    // Chờ có chữ trong ô, hoặc nút gửi sáng lên (khi site đổi paste dài thành file đính kèm)
    const t0 = Date.now();
    while (Date.now() - t0 < 2500) {
      if (composerText(el) || enabled(findSend())) return;
      await sleep(150);
    }
    document.execCommand('insertText', false, text); // phương án dự phòng
    await sleep(400);
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
        })
      );
    }
  }

  async function clickSend(ctrl) {
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      if (ctrl.cancelled) throw new Error('cancelled');
      const btn = findSend();
      if (enabled(btn)) {
        btn.click();
        return;
      }
      if (!btn && Date.now() - t0 > 5000) {
        const comp = findComposer();
        if (comp) {
          pressEnter(comp);
          return;
        }
      }
      await sleep(300);
    }
    throw new Error('Nút gửi không khả dụng (quá 60s)');
  }

  // ------------------------------------------------- Chờ trả lời hoàn tất
  function waitDone(baselineId, timeoutMs, ctrl) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let settle = null;
      let lastTxt = null;
      const t0 = Date.now();

      const cleanup = () => {
        finished = true;
        obs.disconnect();
        clearInterval(iv);
        clearTimeout(settle);
      };
      const fail = (msg) => {
        if (finished) return;
        cleanup();
        reject(new Error(msg));
      };

      const check = () => {
        if (finished) return;
        if (ctrl.cancelled) return fail('cancelled');
        const elapsed = Date.now() - t0;
        if (elapsed > timeoutMs) return fail('Hết thời gian chờ trả lời');

        const m = lastMsg();
        // Chỉ chấp nhận tin nhắn MỚI (ID khác baseline) — không bao giờ lấy lượt cũ
        if (!m || m.id === baselineId) {
          if (elapsed > 90000 && !findStop()) fail('Tin nhắn có vẻ chưa được gửi đi');
          return;
        }
        if (!isComplete(m)) {
          clearTimeout(settle);
          settle = null;
          lastTxt = null;
          return;
        }
        const txt = extract(m);
        if (!txt) return;
        if (settle && txt === lastTxt) return; // đang đếm ngược ổn định
        lastTxt = txt;
        clearTimeout(settle);
        settle = setTimeout(() => {
          if (finished) return;
          const m2 = lastMsg();
          const t2 = m2 && m2.id === m.id && isComplete(m2) ? extract(m2) : null;
          if (t2 !== null && t2 === lastTxt) {
            cleanup();
            resolve({ id: m.id, text: t2 });
          } else {
            settle = null;
            check();
          }
        }, SETTLE_MS);
      };

      // MutationObserver không bị throttle mạnh như timer khi tab chạy nền
      const obs = new MutationObserver(check);
      obs.observe(document.body, {
        subtree: true, childList: true, attributes: true, characterData: true,
      });
      const iv = setInterval(check, 1000);
      ctrl.abort = () => fail('cancelled');
      check();
    });
  }

  // --------------------------------------------------------------- Job
  let current = null;

  const report = (msg) => {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (_) {}
  };

  async function runJob({ runId, text, timeoutMs }) {
    const ctrl = { cancelled: false, abort: null };
    current = ctrl;
    try {
      const base = lastMsg();
      const baselineId = base ? base.id : null; // ghi nhớ lượt cuối TRƯỚC khi gửi
      await setComposer(text);
      await clickSend(ctrl);
      const res = await waitDone(baselineId, timeoutMs, ctrl);
      report({ type: 'done', runId, ok: true, text: res.text, id: res.id });
    } catch (e) {
      if (ctrl.cancelled) return;
      report({ type: 'done', runId, ok: false, error: String((e && e.message) || e) });
    } finally {
      if (current === ctrl) current = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    switch (msg.type) {
      case 'ping':
        send({ ok: true, site: SITE });
        return;
      case 'readLast': {
        const m = lastMsg();
        if (!m) return send({ ok: false, error: 'Chưa có câu trả lời nào của chatbot' });
        send({ ok: true, id: m.id, complete: isComplete(m), text: extract(m) });
        return;
      }
      case 'run':
        if (current) return send({ ok: false, error: 'Tab đang bận' });
        runJob(msg);
        send({ ok: true });
        return;
      case 'cancel': {
        if (current) {
          current.cancelled = true;
          if (current.abort) current.abort();
        }
        if (msg.stopGeneration) {
          const b = findStop();
          if (b) b.click();
        }
        send({ ok: true });
        return;
      }
    }
  });
})();
