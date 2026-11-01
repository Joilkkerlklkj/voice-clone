// ── 二维码直出：用本机无头浏览器渲染微信扫码页，把二维码截给前端 ──────────────
//
// 用户需求（2026-10-21）："不能直接生成二维码到前端吗？"
//
// ── 为什么必须分地区看 ──
//   DeepSeek 的登录页按 IP 地区决定给不给微信扫码：
//     · 美国 IP（region=US）→ **不渲染**微信入口，连 wxLogin.js 都不加载 → 扫码无从谈起
//     · 中国 IP（region=CN）→ 正常渲染「Scan with Wechat to login」+ 二维码
//   所以这个功能在境内节点（阿里云）才有意义；境外节点会明确告知不可用，不假装成功。
//
// ── 实现路径 ──
//   起一个临时 Chromium（headless）→ 打开 chat.deepseek.com/sign_in
//   → 等页面出现微信字样（说明组件加载完）→ CDP 截图（截二维码那块区域）
//   → 返回 PNG（base64），交给面板显示。
//
//   扫码后**不要**去抓回调 URL（那条路已证伪：nonce 是一次性的，
//   页面一加载就被前端换掉）。正确做法是让这个浏览器自己完成登录，
//   然后从它的 localStorage 读出 userToken —— 所以这里保活浏览器 profile。
//
// ── 资源纪律（记忆 00 铁律 0.9）──
//   Chromium 是重内存进程（约 150-250MB）。全程串行：同一时刻只允许一个实例，
//   用完立即 kill；并设置内存上限参数。绝不允许并发起多个。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DS_SIGNIN = 'https://chat.deepseek.com/sign_in';

/**
 * 默认 profile 目录（浏览器登录态就存这里）。
 *
 * 🔴 两个都不能用（2026-10-22 两次踩坑）：
 *    ① `/tmp` —— 系统会清、重启会丢 → 反复扫码；
 *    ② `plugins/voice/` 里面 —— 升级插件要「删目录再解压」，profile 被连带删掉 → 又得扫码。
 *    所以放在插件外的持久数据区：`<插件>/../../data/voice-secrets/browser-profile`。
 *    这是**用户资产**，跟代码分开。
 */
export function defaultProfileDir(pluginDir) {
  return path.resolve(pluginDir, '..', '..', 'data', 'voice-secrets', 'browser-profile');
}

/** 串行锁：同一时刻只允许一个渲染任务。带时间戳，超时自动失效（防异常路径永久卡死） */
let busy = false;
let busySince = 0;
const BUSY_TIMEOUT_MS = 180000; // 3 分钟没释放就认为卡死，自动清锁

/** 锁是否真的被占着（超过 BUSY_TIMEOUT_MS 自动判死） */
function isBusy() {
  if (!busy) return false;
  if (Date.now() - busySince > BUSY_TIMEOUT_MS) {
    busy = false; busySince = 0;
    return false;
  }
  return true;
}

/** 外部强制清锁 + 清残留进程（面板「取消」用） */
export function forceReset() {
  const was = busy;
  busy = false; busySince = 0;
  return { was, cleared: true };
}

/** 找系统里的 chromium/chrome */
function findChromium(extraPaths = []) {
  const names = ['chromium-browser', 'chromium', 'google-chrome', 'google-chrome-stable', 'chrome'];
  const candidates = [...extraPaths, '/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome'];
  for (const dir of candidates) {
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
  }
  return '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端（只连页面 target） */
class Cdp {
  constructor(wsUrl, WebSocketImpl) {
    this.wsUrl = wsUrl;
    this.WS = WebSocketImpl;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
  }

  async connect(timeoutMs = 15000) {
    await new Promise((resolve, reject) => {
      const ws = new this.WS(this.wsUrl, { perMessageDeflate: false });
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs);
      ws.on('open', () => { clearTimeout(timer); resolve(); });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || JSON.stringify(m.error)));
        else p.resolve(m.result);
      });
    });
    return this;
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面脚本异常');
    return r?.result?.value;
  }

  close() { try { this.ws?.terminate(); } catch { /* ignore */ } }
}

/**
 * 渲染微信扫码页并截出二维码。
 *
 * @param {{profileDir:string, chromiumPath?:string, port?:number, keepAlive?:boolean,
 *          WebSocketImpl:any, timeoutMs?:number, onLog?:Function}} opts
 * @returns {Promise<{ok:boolean, png?:Buffer, region?:string, wechatAvailable?:boolean,
 *                    error?:string, hint?:string, child?:any, cdpUrl?:string, port?:number}>}
 */
export async function renderWechatQr(opts) {
  const {
    profileDir, chromiumPath = '', port = 9451, keepAlive = false,
    WebSocketImpl, timeoutMs = 60000, onLog = () => {}
  } = opts;

  if (isBusy()) {
    const left = Math.ceil((BUSY_TIMEOUT_MS - (Date.now() - busySince)) / 1000);
    return {
      ok: false,
      error: `已有二维码任务在跑（约 ${left}s 后自动解锁），或点面板「强制解锁」立即重置`,
      hint: '如果确认没有任务在跑，点「强制解锁」清掉锁和残留浏览器'
    };
  }

  // 内存门槛（记忆 00 铁律 0.9）：chromium 单实例要 200~300MB，
  // 可用内存不够时硬起只会超时失败，不如直接给明确原因。
  try {
    const mem = fs.readFileSync('/proc/meminfo', 'utf8');
    const availKb = Number((/MemAvailable:\s+(\d+)/.exec(mem) || [])[1] || 0);
    const availMb = Math.round(availKb / 1024);
    if (availMb > 0 && availMb < 250) {
      return {
        ok: false,
        error: `可用内存只剩 ${availMb}MB，不够启动浏览器（需要约 250MB）`,
        hint: '这台机器同时跑着很多 chromium 进程。可以：①稍后再试 ②关掉不用的浏览器标签 ③改用「贴 token」方式登录'
      };
    }
    onLog(`[qr] 可用内存 ${availMb}MB，允许启动`);
  } catch { /* 读不到就不拦 */ }

  busy = true; busySince = Date.now();
  let child = null;
  let cdp = null;
  try {
    const bin = findChromium(chromiumPath ? [chromiumPath] : []);
    if (!bin) {
      return { ok: false, error: '这台机器没有 chromium/chrome，无法渲染二维码' };
    }
    fs.mkdirSync(profileDir, { recursive: true });

    // 内存相关参数：禁用 GPU、限制缓存，单实例
    child = spawn(bin, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--window-size=1280,1000',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      DS_SIGNIN
    ], { stdio: 'ignore', detached: false });

    child.on('error', (e) => onLog('chromium 启动失败:', e?.message));

    // 等 CDP 起来
    let version = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await sleep(700);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) { version = await r.json(); break; }
      } catch { /* 还没起来 */ }
    }
    if (!version) return { ok: false, error: '无头浏览器没起来（CDP 连不上）' };

    // 找 DS 页面
    let page = null;
    for (let i = 0; i < 20 && !page; i++) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && /deepseek\.com/.test(t.url || ''));
      if (!page) await sleep(800);
    }
    if (!page) return { ok: false, error: '无头浏览器里没打开 DS 登录页' };

    cdp = await new Cdp(page.webSocketDebuggerUrl, WebSocketImpl).connect();
    await cdp.send('Page.enable');

    // 🔴 关键（2026-10-22 踩坑）：
    //    profile 里已有登录态时，浏览器直接进首页（chat.deepseek.com/），**不是登录页** ——
    //    于是既看不到二维码、也判断不出"该地区是否支持扫码"，只会误报"不提供扫码入口"。
    //
    // 🔴 2026-10-22 重要修正 —— **绝不再删 localStorage 里的 token**！
    //    早版这里 `localStorage.removeItem('userToken')` 主动登出，结果：
    //      · 主人点一次「生成二维码」就把正在用的登录态清掉了；
    //      · 若之后没扫码（只是看看），浏览器就一直是未登录 → 唱歌全失败。
    //    这是"老是掉线"的直接原因之一。
    //    改法：**只做导航**（去登录页），不碰 localStorage。
    //    DS 的登录页对已登录用户会自动跳首页 —— 那也没关系，我们会明确告诉调用方
    //    "当前已有登录态，要看二维码请用临时 profile 或先切换账号"。
    try {
      const st = await cdp.eval(`(() => {
        try { const v = JSON.parse(localStorage.getItem('userToken') || 'null'); return { logged: !!(v && v.value), url: location.href }; }
        catch { return { logged: false, url: location.href }; }
      })()`);
      if (st && st.logged) {
        // 已登录：**不动 token**，只记录，让上层决定（上层会走"临时干净 profile"分支）
        onLog('[qr] 当前 profile 已登录，为保护登录态，本次不改动它');
        return {
          ok: false,
          region: '',
          wechatAvailable: false,
          loggedInProfile: true,
          error: '当前浏览器已登录 DeepSeek（为了不把你踢下线，这里没有清登录态）',
          hint: '如果要看二维码换号：用面板的「强制解锁」后再点「生成二维码」（会使用独立临时 profile，不影响现有登录）；'
            + '或者直接「贴 token」添加另一个账号。'
        };
      }
      if (st && !/sign_in/.test(st.url)) {
        await cdp.send('Page.navigate', { url: 'https://chat.deepseek.com/sign_in' }, 20000);
        await sleep(2000);
      }
    } catch (e) {
      onLog('[qr] 跳转登录页失败（继续尝试）:', e?.message);
    }

    // 等页面渲染出内容 + 判断地区/微信入口
    // 🔴 踩坑（2026-10-22）：判定条件太窄 → 阿里云（CN）明明有扫码入口却报"不支持"。
    //    原因：① 页面是英文界面显示 "Scan with Wechat"，早期正则只匹配中文"微信扫码"；
    //          ② wxLogin 是异步注入的 script，页面初到时可能还没加上，
    //            必须**持续轮询**直到出现或超时，不能看一次就下结论。
    let info = { region: '', wechat: false, text: '' };
    const pollMs = Math.min(timeoutMs, 45000);
    const t0 = Date.now();
    while (Date.now() - t0 < pollMs) {
      await sleep(1800);
      try {
        info = await cdp.eval(`(() => {
          const meta = (n) => document.querySelector('meta[name="'+n+'"]')?.content || '';
          const txt = document.body.innerText || '';
          return {
            region: meta('region'),
            wechat: !!document.querySelector('script[data-wxlogin]')
              || !!document.querySelector('iframe[src*="open.weixin"]')
              || /Scan with Wechat|Scan with WeChat|微信扫码|扫码登录|用微信登录/i.test(txt),
            text: txt.slice(0, 300)
          };
        })()`);
      } catch { continue; }
      // 有正文且已出现微信入口 → 立刻继续；否则继续等（wxLogin 注入有延迟）
      if (info.text && info.text.length > 40 && info.wechat) break;
    }

    if (!info.text || info.text.length < 40) {
      return { ok: false, error: 'DS 登录页没渲染出来（可能网络不通或页面改版）', region: info.region };
    }

    if (!info.wechat) {
      return {
        ok: false,
        region: info.region || '未知',
        wechatAvailable: false,
        error: `当前出口 IP 地区是 ${info.region || '未知'}，DeepSeek 不提供微信扫码入口`,
        hint: info.region === 'US'
          ? '美国 IP 不显示微信扫码。请在境内节点（如阿里云）使用此功能，或在你自己的电脑上扫码后把 token 贴进来'
          : '该地区不支持扫码登录，可改用「贴 token」通道'
      };
    }

    // 找到二维码所在区域并截图（微信组件是 iframe 或 img，优先截元素）
    const rect = await cdp.eval(`(() => {
      const pick = () => {
        // 微信 WxLogin 会插入 iframe#login_container 或 img
        const cands = [
          ...document.querySelectorAll('iframe'),
          ...document.querySelectorAll('img')
        ];
        for (const el of cands) {
          const b = el.getBoundingClientRect();
          if (b.width >= 120 && b.height >= 120) {
            return { x: b.x, y: b.y, w: b.width, h: b.height };
          }
        }
        return null;
      };
      const r = pick();
      return r ? JSON.stringify(r) : '';
    })()`);

    let clip = null;
    if (rect) {
      try {
        const o = JSON.parse(rect);
        // 外扩一点边距，保证二维码完整
        clip = { x: Math.max(0, o.x - 8), y: Math.max(0, o.y - 8), width: o.w + 16, height: o.h + 16, scale: 2 };
      } catch { /* 用整页 */ }
    }

    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip } : {})
    }, 30000);
    if (!shot?.data) return { ok: false, error: '截图失败' };

    const png = Buffer.from(shot.data, 'base64');

    if (keepAlive) {
      // 保活：浏览器继续跑，让用户扫码；登录态会落在 profileDir 里
      cdp.close();
      cdp = null;
      child.unref?.();
      return { ok: true, png, region: info.region, wechatAvailable: true, child, cdpUrl: `http://127.0.0.1:${port}`, port };
    }

    return { ok: true, png, region: info.region, wechatAvailable: true };
  } catch (e) {
    return { ok: false, error: `渲染二维码失败：${e?.message ?? e}` };
  } finally {
    busy = false; busySince = 0;
    if (!keepAlive) {
      cdp?.close();
      try { child?.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
}

/**
 * 关闭浏览器 —— 必须让 localStorage 可靠刷盘。
 *
 * 🔴 踩坑记录（2026-10-22）：以前直接 `SIGKILL`，浏览器来不及把 localStorage
 * 写进 LevelDB，导致「扫码登录成功 → 关掉 → 再启动又不认识你了」，只能反复扫码。
 * 正确顺序：① 通过 CDP 调 `Browser.close`（浏览器自己走正常退出流程、刷盘）
 *          ② 等进程退出（最多 5 秒）
 *          ③ 还不退才 SIGKILL 兜底。
 *
 * @param {any} child - 子进程
 * @param {{port?:number, WebSocketImpl?:any}} opts
 */
export async function gracefulClose(child, { port, WebSocketImpl } = {}) {
  // ① 尝试 CDP Browser.close
  if (port) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
      if (v?.webSocketDebuggerUrl && WebSocketImpl) {
        await new Promise((resolve) => {
          const ws = new WebSocketImpl(v.webSocketDebuggerUrl, { perMessageDeflate: false });
          const done = () => { try { ws.terminate(); } catch { /* ignore */ } resolve(); };
          const timer = setTimeout(done, 4000);
          ws.on('open', () => {
            try { ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); } catch { done(); }
          });
          ws.on('close', () => { clearTimeout(timer); resolve(); });
          ws.on('error', () => { clearTimeout(timer); done(); });
        });
        // ② 等进程退出
        const t0 = Date.now();
        while (Date.now() - t0 < 5000) {
          if (!child || child.exitCode !== null) break;
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    } catch { /* 走兜底 */ }
  }

  // ③ 兜底：先 SIGTERM（可被捕获、有机会刷盘），最后 SIGKILL
  if (child && child.exitCode === null) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  }
  return { ok: true };
}

/** 同步版（旧接口兼容）：只发 SIGTERM，尽量给刷盘留时间 */
export function killQrBrowser(child) {
  try { child?.kill('SIGTERM'); } catch { /* ignore */ }
  return { ok: true };
}

/** 等 LevelDB 落盘（关浏览器后再观察 profile 是否有写入） */
export async function waitProfileFlush(profileDir, ms = 3000) {
  const dir = path.join(profileDir, 'Default', 'Local Storage', 'leveldb');
  const t0 = Date.now();
  let lastSize = -1;
  while (Date.now() - t0 < ms) {
    try {
      const files = fs.readdirSync(dir);
      const size = files.reduce((n, f) => {
        try { return n + fs.statSync(path.join(dir, f)).size; } catch { return n; }
      }, 0);
      if (size === lastSize && size > 0) return { ok: true, bytes: size };
      lastSize = size;
    } catch { /* 目录还没生成 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: lastSize > 0, bytes: lastSize };
}
