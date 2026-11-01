// ── DeepSeek 账号接入（登录态 + 凭据持久化）────────────────────────────────
//
// 用户需求（2026-10-21）："把登陆信息这个调用全部都集成到插件文件内，
//   并且前端展示 DS 官方登陆端口"。
//
// ── 三条通道，全都收在插件内 ──
//   ① 短信验证码登录（面板直接填手机号）→ 需要过数美验证码；
//   ② Token 直贴（推荐）：在自己浏览器登录后复制 userToken 贴进面板；
//   ③ 从本机浏览器读取（如果远程浏览器里已登录，一键提取）。
//
// ── 为什么短信登录要过验证码（不能替用户绕）──
//   实测：PoW 校验已通过（difficulty=20 已解出、服务端不再报 PoW 错误），
//   但服务端随后要求 body.shumei_verification —— 数美滑块的活体风控。
//   那是 DS 用来区分"真人/脚本"的安全机制，**不绕过**（记忆 00 边界 14）。
//   面板因此把验证码引导到官方页面由本人完成，我们只接管产出的登录态。
//
// ── 凭据纪律（记忆 00 边界 4）──
//   token 落盘在 data/plugins/voice/ds-credentials.json（0600），
//   **面板永不回显原文**（只给前 6 位掩码 + 长度），不进日志、不进对话。
import fs from 'node:fs';
import path from 'node:path';
import { solvePow, guestPowHeader } from './pow.js';

const DS = 'https://chat.deepseek.com';
const API = `${DS}/api/v0`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Origin: DS,
  Referer: `${DS}/sign_in`,
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9'
};

/** 掩码：永不返回原文 */
export function maskToken(t) {
  if (!t) return '';
  return `${t.slice(0, 6)}${'*'.repeat(Math.max(0, Math.min(28, t.length - 6)))}`;
}

/**
 * 凭据文件路径。
 *
 * 🔴 为什么要用独立目录（2026-10-22 事故）：早版把凭据存在 `plugins/voice/` 里，
 *    每次升级插件都要「先删目录再解压」，凭据就被连带删掉 —— 用户被迫反复扫码登录。
 *    凭据是**用户资产**，不该跟代码同生共死。所以放到插件外：
 *      <插件目录>/../../data/voice-secrets/ds-credentials.json
 *    并兼容读取旧位置（存在就迁移过来）。
 */
function credPath(pluginDir) {
  const outsideDir = path.resolve(pluginDir, '..', '..', 'data', 'voice-secrets');
  return path.join(outsideDir, 'ds-credentials.json');
}

/** 旧位置（plugins/voice/ds-credentials.json），用于一次性迁移 */
function legacyCredPath(pluginDir) {
  return path.join(pluginDir, 'ds-credentials.json');
}

/**
 * 账号池结构（2026-10-22 加「切号」功能）：
 *   {
 *     "activeId": "acc_xxx",              ← 当前使用的账号
 *     "accounts": [
 *       { id, token, mobile, source, savedAt, label, voiceId }
 *     ]
 *   }
 * 兼容旧格式（单凭据 {token,...}）：读到就自动升级成单账号池。
 */
function emptyStore() {
  return { activeId: '', accounts: [] };
}

/** 读整个账号池（含旧格式自动升级） */
function readStore(pluginDir) {
  const p = credPath(pluginDir);
  try {
    if (!fs.existsSync(p)) {
      // 尝试从旧位置迁移
      const legacy = legacyCredPath(pluginDir);
      if (!fs.existsSync(legacy)) return emptyStore();
      const old = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      if (!old?.token) return emptyStore();
      const st = {
        activeId: 'acc_legacy',
        accounts: [{
          id: 'acc_legacy',
          token: old.token,
          mobile: old.mobile || '',
          source: old.source || 'legacy',
          savedAt: old.savedAt || new Date().toISOString(),
          label: old.mobile || '旧账号'
        }]
      };
      writeStore(pluginDir, st);
      return st;
    }
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    // 旧格式（扁平单凭据）→ 升级
    if (raw && typeof raw.token === 'string' && !raw.accounts) {
      const st = {
        activeId: 'acc_1',
        accounts: [{
          id: 'acc_1',
          token: raw.token,
          mobile: raw.mobile || '',
          source: raw.source || 'legacy',
          savedAt: raw.savedAt || new Date().toISOString(),
          label: raw.mobile || '账号 1'
        }]
      };
      writeStore(pluginDir, st);
      return st;
    }
    if (!raw || !Array.isArray(raw.accounts)) return emptyStore();
    return raw;
  } catch {
    return emptyStore();
  }
}

/** 写账号池（0600） */
function writeStore(pluginDir, store) {
  const p = credPath(pluginDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store, null, 2), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* ignore */ }
  return p;
}

/** 取当前活跃账号的凭据；没有则 null */
export function loadCredentials(pluginDir) {
  const st = readStore(pluginDir);
  if (!st.accounts.length) return null;
  const cur = st.accounts.find((a) => a.id === st.activeId) || st.accounts[0];
  return cur || null;
}

/** 列出全部账号（token 只给掩码，绝不外泄原文） */
export function listAccounts(pluginDir) {
  const st = readStore(pluginDir);
  return {
    activeId: st.activeId,
    accounts: st.accounts.map((a) => ({
      id: a.id,
      label: a.label || a.mobile || a.id,
      mobile: a.mobile || '',
      source: a.source || '',
      savedAt: a.savedAt || '',
      tokenMask: maskToken(a.token),
      isActive: a.id === st.activeId
    }))
  };
}

/**
 * 保存/更新账号。
 * 同 token 已存在 → 更新元信息；否则新增一条并设为活跃。
 */
export function saveCredentials(pluginDir, { token, mobile = '', source = 'paste', label = '' }) {
  const st = readStore(pluginDir);
  const exist = st.accounts.find((a) => a.token === token);
  if (exist) {
    exist.mobile = mobile || exist.mobile;
    exist.source = source || exist.source;
    if (label) exist.label = label;
    st.activeId = exist.id;
  } else {
    const id = `acc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    st.accounts.push({
      id,
      token,
      mobile,
      source,
      savedAt: new Date().toISOString(),
      label: label || mobile || `账号 ${st.accounts.length + 1}`
    });
    st.activeId = id;
  }
  return writeStore(pluginDir, st);
}

/** 切换到指定账号 */
export function switchAccount(pluginDir, accountId) {
  const st = readStore(pluginDir);
  const hit = st.accounts.find((a) => a.id === accountId);
  if (!hit) return { ok: false, error: '找不到这个账号' };
  st.activeId = accountId;
  writeStore(pluginDir, st);
  return { ok: true, account: { id: hit.id, label: hit.label, mobile: hit.mobile } };
}

/** 删除指定账号（删活跃账号时自动切到剩下的第一个） */
export function removeAccount(pluginDir, accountId) {
  const st = readStore(pluginDir);
  const before = st.accounts.length;
  st.accounts = st.accounts.filter((a) => a.id !== accountId);
  if (st.accounts.length === before) return { ok: false, error: '找不到这个账号' };
  if (st.activeId === accountId) st.activeId = st.accounts[0]?.id || '';
  writeStore(pluginDir, st);
  return { ok: true, remaining: st.accounts.length, activeId: st.activeId };
}

/** 清空全部账号（登出） */
export function clearCredentials(pluginDir) {
  const p = credPath(pluginDir);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
  return p;
}

/** 打 DS 接口，解开双层信封 */
async function dsApi(pathname, { token = '', method = 'POST', body, headers = {}, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${pathname}`, {
      method,
      headers: {
        ...HEADERS,
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    let raw;
    try { raw = JSON.parse(text); } catch {
      return { ok: false, status: res.status, error: `DS 返回非 JSON（HTTP ${res.status}）`, detail: text.slice(0, 200) };
    }
    // 🔴 FastAPI 校验失败（422）返回的是 {detail:[{loc:"body.xxx"}]}，没有 code 字段 ——
    // 早版把这种响应当成成功（raw.code undefined 直接放行），会把"缺验证码"误报成"发码成功"。
    // 必须先看 HTTP 状态，再解析 code。
    if (!res.ok) {
      const locs = Array.isArray(raw?.detail)
        ? raw.detail.map((x) => String(x?.loc ?? '')).filter(Boolean)
        : [];
      return {
        ok: false,
        status: res.status,
        missing: locs,
        error: locs.length ? `DS 要求必填字段：${locs.join(', ')}` : `DS 拒绝请求（HTTP ${res.status}）`,
        detail: typeof raw?.detail === 'string' ? raw.detail : JSON.stringify(raw).slice(0, 240)
      };
    }
    if (raw?.code !== undefined && raw.code !== 0) {
      const map = {
        40002: '缺少登录 token',
        40003: '登录态无效或已过期，请重新登录',
        40300: 'PoW 请求头有误（需要重新计算）',
        40301: 'PoW 应答无效'
      };
      return { ok: false, status: res.status, code: raw.code, error: map[raw.code] || `DS code=${raw.code}`, detail: raw.msg || '' };
    }
    const biz = raw?.data;
    if (biz && biz.biz_code !== undefined && biz.biz_code !== 0) {
      return { ok: false, status: res.status, code: biz.biz_code, error: biz.biz_msg || `biz_code=${biz.biz_code}`, detail: '' };
    }
    return { ok: true, status: res.status, data: biz?.biz_data ?? null };
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, error: `请求超时（${timeoutMs}ms）`, detail: pathname };
    return { ok: false, error: `请求失败：${e?.message ?? e}`, detail: pathname };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 校验 token 是否可用（并顺带取账号信息）。
 * @returns {{ok:boolean, valid?:boolean, currentVoice?:string, voices?:Array, error?:string}}
 */
export async function verifyToken(token) {
  if (!token) return { ok: true, valid: false, error: '没有 token' };
  const v = await dsApi('/chat/tts/voices', { token, method: 'GET' });
  if (!v.ok) {
    if (v.code === 40003 || v.code === 40002) return { ok: true, valid: false, error: '登录态无效或已过期' };
    return { ok: false, valid: false, error: v.error };
  }
  const list = Array.isArray(v.data?.voices) ? v.data.voices : [];
  return {
    ok: true,
    valid: true,
    currentVoice: v.data?.current_voice_id || v.data?.default_voice_id || '',
    voices: list.map((x) => ({
      id: x.voice_id,
      name: x.name_i18n?.zh || x.name_i18n?.en || x.voice_id,
      demo: Array.isArray(x.demo_urls) ? x.demo_urls[0] : ''
    }))
  };
}

/**
 * 发短信验证码（第一步）。
 *
 * ⚠️ 实测结论（重要，别误判）：PoW 已经不是障碍 —— difficulty=20 的 challenge
 * 我们能在 4 秒内解出、服务端也认这个头（不再报 40300/40301）；
 * 剩下的 422 只差 `shumei_verification`（数美活体验证码），那是给真人过的。
 * 所以本函数会在缺票时明确返回 needCaptcha，把用户引到官方页面，而不是硬撞。
 */
export async function sendSmsCode(mobile, { areaCode = '+86', deviceId = '' } = {}) {
  const target = '/api/v0/users/create_sms_verification_code';
  const c = await dsApi('/users/create_guest_challenge', { body: { target_path: target } });
  if (!c.ok) return { ok: false, error: `取 challenge 失败：${c.error}` };
  const ch = c.data?.guest_challenge;
  if (!ch) return { ok: false, error: 'DS 没有返回 challenge' };

  const solved = await solvePow(ch);
  const powHeader = guestPowHeader(ch, solved.answer);

  const r = await dsApi('/users/create_sms_verification_code', {
    body: {
      locale: 'zh_CN',
      turnstile_token: '',
      shumei_verification: '',
      hcaptcha_token: '',
      device_id: deviceId,
      scenario: 'login',
      mobile_number: String(mobile || '').replace(/^\+?86/, ''),
      ticket: ''
    },
    headers: { 'X-DS-Guest-PoW-Response': powHeader }
  });

  if (r.ok) return { ok: true, powMs: solved.elapsedMs, needCaptcha: false };
  // 缺数美票 → 明确告知，并给官方入口（不绕过风控）
  const missing = (r.missing || []).join(' ');
  if (/shumei/i.test(missing) || /shumei/i.test(r.detail || '') || /shumei/i.test(r.error || '')) {
    return {
      ok: false,
      needCaptcha: true,
      powSolved: true,
      powMs: solved.elapsedMs,
      error: 'DS 要求「数美验证码」（真人风控，不可代过）',
      hint: '请用下面的官方登录入口，在页面里完成验证码登录；登录后把 userToken 贴回来（或直接用浏览器登录态）',
      officialLoginUrl: `${DS}/sign_in`
    };
  }
  return { ok: false, error: r.error, detail: r.detail };
}

/**
 * 短信验证码登录（第二步）。
 * @returns {{ok:boolean, token?:string, error?:string}}
 */
export async function loginBySms(mobile, code, { areaCode = '+86', deviceId = '' } = {}) {
  const target = '/api/v0/users/login_by_mobile_sms';
  const c = await dsApi('/users/create_guest_challenge', { body: { target_path: target } });
  if (!c.ok) return { ok: false, error: `取 challenge 失败：${c.error}` };
  const ch = c.data?.guest_challenge;
  if (!ch) return { ok: false, error: 'DS 没有返回 challenge' };

  const solved = await solvePow(ch);
  const r = await dsApi('/users/login_by_mobile_sms', {
    body: {
      region: 'CN',
      locale: 'zh_CN',
      mobile_number: String(mobile || '').replace(/^\+?86/, ''),
      area_code: areaCode,
      sms_verification_code: String(code || ''),
      device_id: deviceId,
      os: 'web'
    },
    headers: { 'X-DS-Guest-PoW-Response': guestPowHeader(ch, solved.answer) }
  });
  if (!r.ok) return { ok: false, error: r.error, detail: r.detail };

  const user = r.data?.user || {};
  const token = user.token || user.user_token || '';
  if (!token) return { ok: false, error: '登录成功但没返回 token（DS 接口变了）', detail: JSON.stringify(user).slice(0, 200) };
  return { ok: true, token, user: { id: user.id, email: user.email, mobile: user.mobile_number } };
}

/**
 * 从本机浏览器（CDP）读已登录的 token。
 * 这是"登录集成进插件"的第三通道：浏览器已经登录过就直接拿来用。
 */
/**
 * 从任意一段"回调 URL / 裸 nonce"里抽出 nonce。
 *
 * 扫码成功后 DS 会把你重定向到形如：
 *   https://chat.deepseek.com/sign_in?nonce=<32位hex>&provider=WECHAT
 * 但用户手上可能是：
 *   ① 完整 URL（推荐，最不容易错）
 *   ② 只有 nonce 串
 *   ③ URL 里还夹着别的参数（redirect / new 等）
 * 所以这里做宽松解析：能当 URL 解析就取 query，否则当裸串。
 */
export function parseNonce(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: '没有提供 nonce' };
  // 情况 ②：看起来就是一段 nonce（16~128 位十六进制/字母数字，不含 ? & / 空格）
  if (!/[?&\/\s]/.test(raw) && /^[A-Za-z0-9_-]{8,200}$/.test(raw)) {
    return { ok: true, nonce: raw, provider: 'WECHAT', from: 'bare' };
  }
  // 情况 ①③：按 URL 解析
  let url;
  try {
    url = new URL(raw, 'https://chat.deepseek.com');
  } catch {
    return { ok: false, error: '这段内容既不是 URL 也不像 nonce' };
  }
  const nonce = url.searchParams.get('nonce') || '';
  if (!nonce) {
    // 兜底：从整串里正则捞 nonce=xxx
    const m = /[?&]nonce=([^&\s]+)/.exec(raw);
    if (!m) return { ok: false, error: '这段 URL 里没有 nonce 参数（确认是扫码完成后的跳转地址）' };
    return { ok: true, nonce: decodeURIComponent(m[1]), provider: 'WECHAT', from: 'regex' };
  }
  const provider = (url.searchParams.get('provider') || 'WECHAT').toUpperCase();
  return { ok: true, nonce, provider, from: 'url' };
}

/**
 * 用扫码得到的 nonce 换 token。
 *
 * 链路（逆向自 DS 前端 + 实测）：微信扫码 → DS 服务端回调处理 →
 * 302 到 /sign_in?nonce=xxx&provider=WECHAT → 前端调本接口换 token。
 *
 * 这个接口是三条登录通道里**最干净的**：无 WAF、无 PoW、无验证码，
 * 纯 JSON。实测 provider 必须大写（小写会 422）。
 *
 * @param {string} nonceInput - 回调 URL 或裸 nonce
 * @returns {Promise<{ok:boolean, token?:string, nonce?:string, error?:string}>}
 */
export async function loginByNonce(nonceInput) {
  const parsed = parseNonce(nonceInput);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.provider !== 'WECHAT' && parsed.provider !== 'GOOGLE') {
    return { ok: false, error: `不支持的 provider：${parsed.provider}（只认 WECHAT / GOOGLE）` };
  }

  const r = await dsApi('/users/oauth/get_token', {
    body: { nonce: parsed.nonce, provider: parsed.provider }
  });

  if (!r.ok) {
    // biz_code=1 NONCE_NOT_FOUND 是最常见的失败：nonce 过期/已被用过/抄错
    if (/NONCE_NOT_FOUND/.test(r.detail || '') || /NONCE_NOT_FOUND/.test(r.error || '')) {
      return {
        ok: false,
        nonce: parsed.nonce,
        error: 'nonce 无效或已过期（nonce 一次性、约 5 分钟内有效）',
        hint: '重新扫一次码，把跳转后地址栏的完整 URL 立刻复制过来'
      };
    }
    return { ok: false, nonce: parsed.nonce, error: r.error, detail: r.detail };
  }

  const token = typeof r.data?.token === 'string' ? r.data.token : '';
  if (!token) return { ok: false, error: 'DS 返回了空 token（接口可能变了）', detail: JSON.stringify(r.data).slice(0, 200) };
  return { ok: true, token, nonce: parsed.nonce, provider: parsed.provider };
}

/** 官方登录页（扫码入口） */
export const DS_SIGNIN_URL = `${DS}/sign_in`;

export async function readTokenFromBrowser(cdpUrl = 'http://127.0.0.1:9222') {
  try {
    const list = await (await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    let page = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && /chat\.deepseek\.com/.test(t.url || ''));
    // 没开 DS 页面就顺手开一个，省得用户自己去浏览器里找
    if (!page) {
      try {
        const res = await fetch(`${cdpUrl}/json/new?${encodeURIComponent(`${DS}/sign_in`)}`, {
          method: 'PUT', signal: AbortSignal.timeout(15000)
        });
        if (res.ok) page = await res.json();
      } catch { /* 下面统一报错 */ }
    }
    if (!page) return { ok: false, error: '远程浏览器里没有 chat.deepseek.com 页面，且自动打开失败' };
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    const token = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error('CDP 超时')); }, 10000);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: `(() => { try { const v = JSON.parse(localStorage.getItem('userToken') || 'null'); return (v && typeof v.value === 'string') ? v.value : (typeof v === 'string' ? v : '') } catch { return '' } })()`,
            returnByValue: true
          }
        }));
      });
      ws.on('message', (raw) => {
        clearTimeout(timer);
        try {
          const m = JSON.parse(raw.toString());
          const v = m?.result?.result?.value;
          ws.terminate();
          resolve(typeof v === 'string' ? v : '');
        } catch (e) { reject(e); }
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    if (!token) return { ok: false, error: '浏览器里的 DS 页面未登录（userToken 为空）' };
    return { ok: true, token };
  } catch (e) {
    return { ok: false, error: `读浏览器失败：${e?.message ?? e}` };
  }
}
