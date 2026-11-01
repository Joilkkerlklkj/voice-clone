// ── 页面内投递（模拟真人操作 UI）：彻底绕开 PoW 逆向 ────────────────────────
//
// 用户需求（2026-10-22）："模拟浏览器发消息可以吗？"
//
// ── 为什么这是最优解 ──
//   整条链路只有**投递**这一步需要 PoW（`X-DS-PoW-Response`），而我逆向卡在
//   `40301 INVALID_POW_RESPONSE`。但**合成**（ticket + wss）完全不需要 PoW —— 已实测通过。
//
//   所以：投递交给**真实页面 UI**（人怎么发它就怎么发，PoW/指纹/cf 全由页面处理），
//   合成仍走纯 Node（ticket + wss）。这样一步都不碰逆向。
//
// ── 做法 ──
//   ① CDP 连到已登录的 DS 页面（复用扫码时的 profile，不用重新登录）
//   ② 找到输入框（textarea 或 contenteditable），把文本塞进去
//   ③ 点发送（或回车）—— 页面自己完成 PoW + 流式回复
//   ④ 等回复结束，查会话历史拿 message_id
//   ⑤ 交给 deepseek-tts.js 合成音频
//
// ── 资源纪律（铁律 0.9）──
//   阿里云 1.8G 内存。浏览器单实例、禁 GPU、静音、串行投递；profile 复用不重建。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DS = 'https://chat.deepseek.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 串行锁：同一时刻只允许一次投递（浏览器 + 流式回复都吃资源） */
let busy = false;

function findChromium(extra = []) {
  const names = ['chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable'];
  const dirs = [...extra, '/usr/bin', '/usr/local/bin', '/snap/bin'];
  for (const d of dirs) for (const n of names) {
    const p = path.join(d, n);
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return '';
}

/** 极简 CDP 客户端（页面级 target，不做 sessionId 转发） */
class Cdp {
  constructor(wsUrl, WS) { this.wsUrl = wsUrl; this.WS = WS; this.seq = 0; this.pending = new Map(); }

  async connect(timeoutMs = 20000) {
    await new Promise((resolve, reject) => {
      const ws = new this.WS(this.wsUrl, { perMessageDeflate: false });
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs);
      ws.on('open', () => { clearTimeout(timer); resolve(); });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message || JSON.stringify(m.error))) : p.resolve(m.result);
      });
    });
    return this;
  }

  send(method, params = {}, timeoutMs = 45000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  async eval(expression, { timeoutMs = 60000 } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true
    }, timeoutMs);
    if (r?.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本异常');
    }
    return r?.result?.value;
  }

  close() { try { this.ws?.terminate(); } catch { /* ignore */ } }
}

/** 起浏览器（同端口已有实例则复用） */
export async function ensureBrowser({ profileDir, port = 9461, onLog = () => {} }) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
    if (v?.webSocketDebuggerUrl) {
      // 端口通不代表页面健康：可能是上次卡死的实例（页面空白/无响应）。
      // 探一下是否有可用页面，有才复用；否则杀掉重建。
      let healthy = false;
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
        const pages = (Array.isArray(list) ? list : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        healthy = pages.length > 0;
      } catch { healthy = false; }
      if (healthy) return { ok: true, reused: true, port, browser: v.Browser };
      onLog(`[page] :${port} 上有实例但无可用页面，清理后重建`);
      try {
        const { execFile } = await import('node:child_process');
        await new Promise((r) => execFile('pkill', ['-9', '-f', `remote-debugging-port=${port}`], () => r()));
      } catch { /* ignore */ }
      await sleep(2000);
    }
  } catch { /* 未运行 */ }

  const bin = findChromium();
  if (!bin) return { ok: false, error: '这台机器没有 chromium/chrome，无法驱动页面投递' };

  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(bin, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-extensions', '--disable-background-networking', '--mute-audio',
    '--window-size=1280,1000',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    `${DS}/`
  ], { stdio: 'ignore' });
  child.on('error', (e) => onLog('chromium 启动失败:', e?.message));
  child.unref?.();

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await sleep(700);
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
      if (v?.webSocketDebuggerUrl) return { ok: true, reused: false, port, browser: v.Browser, child };
    } catch { /* 继续等 */ }
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  return { ok: false, error: '无头浏览器启动超时' };
}

/** 找 DS 页面；没有就开一个 */
async function pickPage(port) {
  for (let i = 0; i < 15; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const hit = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && /chat\.deepseek\.com/.test(t.url || ''));
    if (hit) return hit;
    if (i === 0) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${DS}/`)}`, {
          method: 'PUT', signal: AbortSignal.timeout(10000)
        });
      } catch { /* ignore */ }
    }
    await sleep(800);
  }
  return null;
}

/** 在页面里找输入框并写入文本（React 受控组件需要派发 input 事件） */
const SET_TEXT = (text) => `(() => {
  const sels = ['textarea[placeholder]', 'textarea', 'div[contenteditable="true"]', '[contenteditable="true"]'];
  let el = null, used = '';
  for (const s of sels) {
    for (const c of document.querySelectorAll(s)) {
      const r = c.getBoundingClientRect();
      if (r.width > 80 && r.height > 10) { el = c; used = s; break; }
    }
    if (el) break;
  }
  if (!el) return { ok: false, error: '找不到输入框' };
  el.focus();
  const text = ${JSON.stringify(text)};
  if (el.tagName === 'TEXTAREA') {
    // React 受控：用原生 setter 再派发 input，才能让 React 感知
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, text) : (el.value = text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.innerHTML = '';
    const lines = text.split('\\n');
    lines.forEach((ln, i) => {
      if (i) el.appendChild(document.createElement('br'));
      el.appendChild(document.createTextNode(ln));
    });
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
  }
  return { ok: true, sel: used, tag: el.tagName, value: (el.value || el.innerText || '').slice(0, 60) };
})()`;

/** 点发送按钮；找不到就回车 */
// 发送按钮：DS 的发送是个 .ds-button--primary 的 DIV（不是 <button>）。
// 实测取「最右侧那个 primary」最可靠（输入框右下角），退路才用 aria-label。
const CLICK_SEND = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 8 && r.height > 8; };
  const prim = [...document.querySelectorAll('.ds-button--primary')].filter(vis);
  if (prim.length) {
    // 取 x 最大的（最靠右）
    prim.sort((a, b) => b.getBoundingClientRect().x - a.getBoundingClientRect().x);
    const t = prim[0];
    const r = t.getBoundingClientRect();
    t.click();
    return { ok: true, label: 'primary@' + Math.round(r.x) + ',' + Math.round(r.y) };
  }
  const btns = [...document.querySelectorAll('button, [role="button"]')].filter(vis);
  const bySubmit = btns.find(b => b.getAttribute('type') === 'submit' && !b.disabled);
  if (bySubmit) { bySubmit.click(); return { ok: true, label: 'submit' }; }
  return { ok: false };
})()`;

/**
 * 关掉 DeepThink 与 Search 两个开关（用户 2026-10-22 要求：不用联网搜索、不用思考）。
 *
 * 为什么要在 UI 上关：这两个是页面级开关，请求体里的 thinking_enabled/search_enabled
 * 只对「我们直接发 API」有效；既然改走 UI 模拟，就得点页面上的按钮。
 * 判定"已开启"靠 class 里的高亮态（ds-toggle-button--...active/selected）。
 */
const DISABLE_TOGGLES = `(() => {
  const want = ['DeepThink', 'Search', '深度思考', '智能搜索'];
  const result = [];
  const nodes = [...document.querySelectorAll('.ds-toggle-button, [class*="toggle-button"]')];
  for (const btn of nodes) {
    const txt = (btn.textContent || '').trim();
    if (!want.some((w) => txt.includes(w))) continue;
    const cls = String(btn.className || '');
    // 已开启的高亮态判定：类名里带 active/selected/checked
    const isOn = /active|selected|checked/i.test(cls);
    if (isOn) {
      btn.click();
      result.push({ name: txt, action: 'turned-off' });
    } else {
      result.push({ name: txt, action: 'already-off' });
    }
  }
  return JSON.stringify({ found: nodes.length, result });
})()`;

/** 页面是否还在生成（发送按钮变停止 / 出现停止按钮） */
const IS_STREAMING = `(() => {
  const t = document.body.innerText || '';
  const stopBtn = [...document.querySelectorAll('button, [role="button"]')].find(b => {
    const hay = ((b.getAttribute('aria-label')||'') + ' ' + (b.getAttribute('title')||'') + ' ' + (b.textContent||''));
    return /停止|Stop|stop generating/i.test(hay);
  });
  return { streaming: !!stopBtn, len: t.length };
})()`;

/** 取会话 id（从 URL 或 localStorage） */
const GET_SID = `(() => {
  const m = /\\/a\\/chat\\/s\\/([0-9a-zA-Z-]{8,})/.exec(location.href);
  return m ? m[1] : '';
})()`;

/** 在页面里读会话历史（用页面自己的 token，避免宿主带 token 打接口） */
const READ_HISTORY = (sid) => `(async () => {
  const sid = ${JSON.stringify(String(sid || ''))};
  if (!sid) return { ok: false, rows: [], code: -1, msg: 'no session id' };
  const token = (() => { try { const v = JSON.parse(localStorage.getItem('userToken')||'null'); return v && v.value || ''; } catch { return ''; } })();
  const r = await fetch('/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sid), {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
  });
  const j = await r.json();
  const list = j?.data?.biz_data?.chat_messages || [];
  return { ok: j.code === 0, rows: list.slice(-12), code: j.code, msg: j.msg };
})()`;

/** 归一化历史行 */
function normalize(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    if (!r || typeof r !== 'object') return null;
    const id = r.message_id ?? r.messageId ?? r.msg_id ?? r.id;
    const role = String(r.role ?? r.role_type ?? r.type ?? '').toUpperCase();
    let content = '';
    if (typeof r.content === 'string') content = r.content;
    else if (Array.isArray(r.content)) {
      content = r.content.map((c) => (typeof c === 'string' ? c : c?.content ?? c?.text ?? '')).join('');
    }
    return {
      id: id === undefined || id === null ? '' : String(id),
      role: role === 'ASSISTANT' ? 'assistant' : role === 'USER' ? 'user' : 'other',
      content
    };
  }).filter(Boolean);
}

/**
 * 用页面 UI 投递文本，拿回助手消息的 message_id。
 *
 * @param {string} text - 要投递的文本
 * @param {{profileDir:string, port?:number, WS:any, timeoutMs?:number, onLog?:Function}} opts
 */
export async function deliverViaPage(text, { profileDir, port = 9461, WS, timeoutMs = 180000, onLog = () => {} } = {}) {
  if (busy) return { ok: false, error: '已有一次投递在进行（串行，避免内存不足）' };
  busy = true;
  let cdp = null;
  try {
    const b = await ensureBrowser({ profileDir, port, onLog });
    if (!b.ok) return { ok: false, error: b.error };

    const page = await pickPage(port);
    if (!page) return { ok: false, error: '浏览器里没有 DS 页面' };

    cdp = await new Cdp(page.webSocketDebuggerUrl, WS).connect();
    await cdp.send('Page.enable', {}, 10000);
    await cdp.send('Runtime.enable', {}, 10000);

    // ②-a 🔴 关键：等页面**真正渲染完成**再操作
    //   踩坑（2026-10-22）：CDP 端口一通就返回，但那一刻页面还是 about:blank，
    //   于是 localStorage 读空 → 误判"未登录" → 后续 evaluate 全超时。
    //   必须轮询到 location/body 都有内容为止。
    {
      const t0 = Date.now();
      let ready = false;
      while (Date.now() - t0 < 25000) {
        try {
          const st = await cdp.eval(`(() => {
            const t = document.body ? (document.body.innerText || '') : '';
            return JSON.stringify({ url: location.href, len: t.length, ready: document.readyState });
          })()`);
          const o = JSON.parse(st || '{}');
          if (o.url && !/^about:blank/.test(o.url) && o.ready === 'complete' && o.len > 30) {
            ready = true;
            onLog(`[page] 页面就绪 (${Date.now() - t0}ms, len=${o.len})`);
            break;
          }
        } catch { /* 页面还没上下文，继续等 */ }
        await sleep(600);
      }
      if (!ready) {
        onLog('[page] 页面 25s 内未渲染完成，继续尝试操作（可能失败）');
      }
    }

    // ① 确认已登录
    const logged = await cdp.eval(`(() => {
      try { const v = JSON.parse(localStorage.getItem('userToken')||'null'); return !!(v && v.value); } catch { return false; }
    })()`);
    if (!logged) return { ok: false, error: '浏览器里未登录 DS，请先在面板点「生成二维码」扫码登录' };

    // ② 等输入框就绪（只探测，不写入、不清空）
    let box = null;
    for (let i = 0; i < 20; i++) {
      box = await cdp.eval(`(() => {
        const el = document.querySelector('textarea[placeholder]') || document.querySelector('textarea');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return (r.width > 80 && r.height > 10) ? { ok: true, ph: el.getAttribute('placeholder') || '' } : null;
      })()`);
      if (box?.ok) break;
      await sleep(900);
    }
    if (!box?.ok) return { ok: false, error: 'DS 页面输入框没准备好（页面可能没加载完）' };

    // ②-b 若当前停在登录页，说明 profile 里的登录态没生效
    const onSignIn = await cdp.eval(`/sign_in/.test(location.href)`);
    if (onSignIn) return { ok: false, error: '浏览器里未登录 DS，请先在面板点「生成二维码」扫码登录' };

    // ③ 记录投递前的最后一条助手消息 id（用于识别新回复）
    //    首屏没有会话 id，此时跳过（不能拿空 sid 打接口，会返回 "Failed to ..." 非 JSON）
    const preSid = await cdp.eval(GET_SID);
    const beforeIds = new Set();
    if (preSid) {
      const before = await cdp.eval(READ_HISTORY(preSid));
      for (const m of normalize(before?.rows)) beforeIds.add(m.id);
    }

    // ③-b 关掉 DeepThink / Search（按主人要求：不搜索、不思考）
    try {
      const tg = await cdp.eval(DISABLE_TOGGLES);
      onLog('[page] 开关状态:', tg);
    } catch (e) { onLog('[page] 关开关失败（不影响投递）:', e?.message); }

    // ④ 写入文本
    const typed = await cdp.eval(SET_TEXT(text));
    if (!typed?.ok) return { ok: false, error: `写入文本失败：${typed?.error || '未知'}` };
    await sleep(600);

    // ⑤ 发送
    let sent = await cdp.eval(CLICK_SEND);
    if (!sent?.ok) {
      // 退路：回车
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r'
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
      });
      sent = { ok: true, label: 'enter-key' };
    }

    // ⑥ 等回复结束：先看到开始流式，再等它停下
    const t0 = Date.now();
    let sawStreaming = false;
    let stall = 0;
    let lastLen = 0;
    while (Date.now() - t0 < timeoutMs) {
      await sleep(1500);
      const st = await cdp.eval(IS_STREAMING);
      if (st?.streaming) { sawStreaming = true; lastLen = st.len; stall = 0; continue; }
      if (sawStreaming) break;                       // 流过又停了 → 完成
      if (st && st.len > lastLen) { lastLen = st.len; stall = 0; } else { stall++; }
      if (stall >= 6) break;                          // 12 秒没变化 → 认为没在生成
    }

    // ⑦ 读历史拿新的助手消息（URL 上没 sid 就等它跳转）
    let sid = await cdp.eval(GET_SID);
    for (let i = 0; i < 8 && !sid; i++) {
      await sleep(900);
      sid = await cdp.eval(GET_SID);
    }
    let assistantMsgId = '';
    let answer = '';
    for (let i = 0; i < 6 && !assistantMsgId; i++) {
      const h = await cdp.eval(READ_HISTORY(sid));
      const rows = normalize(h?.rows);
      const fresh = rows.filter((m) => m.role === 'assistant' && !beforeIds.has(m.id));
      const last = fresh.length ? fresh[fresh.length - 1] : rows.filter((m) => m.role === 'assistant').pop();
      if (last?.id) { assistantMsgId = last.id; answer = last.content || ''; break; }
      await sleep(1500);
    }
    if (!assistantMsgId) return { ok: false, error: '投递完成但没拿到助手消息 id' };

    return { ok: true, chatSessionId: sid, assistantMsgId, text: answer, sent: sent.label || 'click' };
  } catch (e) {
    return { ok: false, error: `页面投递失败：${e?.message ?? e}` };
  } finally {
    busy = false;
    cdp?.close();
  }
}

/** 关掉投递用的浏览器 */
export function killPageBrowser(port = 9461) {
  return fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    .then(() => true).catch(() => false);
}
