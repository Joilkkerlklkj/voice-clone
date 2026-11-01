// ── 插件：语音（说 / 听）─────────────────────────────────────────────────
//
// 需求（用户 2026-10-21）：能发语音，也能听懂群友语音。
//
// ── 说（TTS）──
//   edge-tts（微软在线接口，免费免 key）合成 mp3 →
//   发 OneBot 的 record 段 → **NapCat 自己转 silk** → QQ 里是一条语音。
//
//   ⚠️ 关键认知：silk 转码不用我们做。NapCat 官方文档明写
//      「发送时：接口请求后，NapCat 下载到本地，内置 silk/ffmpeg 转码后发送」。
//      所以我们只管把音频文件路径塞进 record 段。
//
// ── 听（STT）──
//   faster-whisper **本地**识别（不联网、不上传隐私）。
//   QQ 语音是 silk 格式，先用 NapCat 的 /get_record?out_format=mp3 转成 mp3，
//   再喂给 whisper。模型默认 small（本机已缓存，中文够用且不太吃内存）。
//
// ── 依赖策略（重要）──
//   本插件不走"插件目录里塞虚拟环境"的路子 —— 那样导出插件包会把
//   32MB 的 aarch64 .so 一起带给别人，到 x86 机器上纯属毒药。
//   改为：依赖写在 manifest.deps 里，由使用者自己装（见 README）。
//   查找解释器时按 venv → 系统 python3 顺序尝试，两边都能跑。
//
// ── 重任务纪律（记忆 00 铁律 0.9）──
//   whisper 是重内存任务，本机 18G/已用 7G。串行化 + 超时 + nice，
//   绝不并发跑多个识别（OOM 过一次的教训）。
//
// ── DeepSeek 官方朗读音色（2026-10-21 v1.2 重构）──
//   那个声音 = DS 自研 TTS（贝壳/白浪/海星/暗潮）。它只认「你自己 DS 会话里的
//   某条助手消息 id」，不接受正文 —— 所以要先把文字投递成一条消息再读。
//   投递需要 PoW，**PoW 已在本插件内纯 Node 实现**（pow.js + 官方 sha3 wasm），
//   实测 difficulty=20 四秒解出、服务端认账。于是整条链路**不需要浏览器**：
//       token → PoW → 投递(SSE) → 拿 message_id → ticket → wss 收 PCM → mp3
//   登录态三条通道全收在插件内（ds-auth.js）：短信登录 / 贴 token / 读本机浏览器。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { ok, err, midHint } from '../../src/core/tool-kit.js';
import {
  DS_VOICES, issueTicket, fetchVoices, synthFromMessage, pcmToWav
} from './deepseek-tts.js';
import { deliverText } from './ds-deliver.js';
import { renderWechatQr, killQrBrowser, gracefulClose, defaultProfileDir, forceReset } from './qr-login.js';
import { deliverViaPage } from './page-deliver.js';
import {
  loadCredentials, saveCredentials, clearCredentials, maskToken,
  verifyToken, sendSmsCode, loginBySms, readTokenFromBrowser,
  loginByNonce, DS_SIGNIN_URL,
  listAccounts, switchAccount, removeAccount
} from './ds-auth.js';


// ── 投递文案模板（v1.9 抽出为模块级函数）──
// 🔴 为什么要抽出来：这两条模板同时被「正式发送路径（synthDs）」和
//    「试音台预览（/api/voice/preview-prompt）」使用。以前散在函数内部，
//    改模板必然漏一处 —— 试听和真发效果不一致，人会被这种 bug 坑很久。
//    模板由用户 2026-10-22 指定，**只替换歌名/文字内容，其余一字不动**。

/** 唱歌模板：自动拆「歌手 歌名」，让模型只吐歌词并加「预备，唱！」 */
/**
 * 唱歌模板。
 *
 * 接受两种调用方式（v1.9.2 起推荐第一种）：
 *   ① buildLyricPrompt({ singer: '张芸京', song: '偏爱' })      ← 试音台两个独立输入框
 *   ② buildLyricPrompt('张芸京 偏爱') / '张芸京的《偏爱》' / '偏爱'  ← 兼容旧的一行字符串
 *
 * 为什么现在优先用对象：旧版只有一个输入框，"离离原上草"这种**古诗**会被当成歌名，
 * 生成「原唱的《离离原上草》」—— 用户看不出这是"歌名"还是"歌词"。拆成两个字段后
 * 语义不言自明，也不会把整段歌词误塞进模板。
 *
 * @param {{singer?:string, song?:string}|string} input
 * @returns {string}
 */
export function buildLyricPrompt(input) {
  let singer = '';
  let song = '';

  if (input && typeof input === 'object') {
    // ① 结构化入参：歌手 / 歌名分开给，不做任何猜测
    singer = String(input.singer ?? '').trim();
    song = String(input.song ?? '').trim();
  } else {
    // ② 单行字符串：拆「A 的 B」/「A - B」/「A B」
    const raw = String(input ?? '')
      .replace(/^预备[，,]?\s*唱[！!]?\s*/, '')
      .replace(/[《》]/g, '')
      .trim();
    song = raw;
    const m = raw.match(/^(.{1,12}?)\s*(?:的|[-—–]|\s)\s*(.+)$/);
    if (m) { singer = m[1].trim(); song = m[2].trim(); }
  }

  // 歌名剥掉书名号（用户可能自己带《》）
  song = song.replace(/[《》]/g, '').trim();
  singer = singer.replace(/[《》]/g, '').trim() || '原唱';

  // 歌名为空时不能瞎编 —— 直接给出可读的兜底，并由调用方校验
  if (!song) song = '';

  return `直接输出，${singer}的《${song}》，不要输出除了歌词以外的内容，`
    + '包括思考内容，制作信息，歌词标题。最后在歌词的最前面加一句"预备，唱！"';
}

/** 朗读模板：只让它回这句话，不带客套、不带思考 */
export function buildSpeakPrompt(input) {
  return `请只回复：【${String(input || '')}】；不含思考不含任何其他输出内容`;
}


// ── 重任务串行锁 ──
// 同一时刻只允许一个 whisper 识别在跑。并发会把内存打爆（铁律 0.9）。
let sttBusy = false;

/** 跑一个子进程，带超时。返回 { code, stdout, stderr } */
function run(cmd, args, { timeoutMs = 60000, env = {} } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...hfEnv(), ...env }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ code: -1, stdout, stderr: stderr + '\n[超时被终止]' });
    }, timeoutMs);

    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -2, stdout, stderr: String(e?.message ?? e) });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * HuggingFace 环境变量（2026-10-21 加）。
 *
 * 🔴 为什么必须有：faster-whisper 首次运行要下载模型，
 *    默认从 huggingface.co 拉 —— **国内机器（阿里云）连不上**，
 *    报 `LocalEntryNotFoundError: Network is unreachable`。
 *
 * 两个修正项：
 *   HF_ENDPOINT        → 用 hf-mirror.com（国内可达的镜像）
 *   HF_HUB_DISABLE_XET → 关掉 xet 传输层
 *      新版 huggingface_hub 默认走 xet，它要连 cas-server.xethub.hf.co，
 *      国内一样不通，报 `401 Unauthorized CAS Client Error`。
 *      关掉后回退到普通 HTTP 下载，镜像可用。
 *
 * 已在配置里显式设置时不覆盖（留给用户/运维自己调）。
 */
function hfEnv() {
  const out = {};
  if (!process.env.HF_ENDPOINT) out.HF_ENDPOINT = 'https://hf-mirror.com';
  if (!process.env.HF_HUB_DISABLE_XET) out.HF_HUB_DISABLE_XET = '1';
  return out;
}

/**
 * 探测某个外部命令是否存在（跨平台、不假设安装路径）。
 *
 * 为什么不用 `which`：不同发行版/容器里 `which` 本身可能没装。
 * 直接 try 执行 `<cmd> -version` 最可靠 —— 能跑起来就是有。
 */
function probeCommand(cmd, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(cmd, ['-version'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      if (done) return; done = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve(false);
    }, timeoutMs);
    child.on('error', () => { if (done) return; done = true; clearTimeout(timer); resolve(false); });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export async function activate(ctx) {
  const pluginDir = ctx.dir;
  const cfg = () => ctx.config.get();

  // ── 解释器与工具查找 ──
  // 优先用插件目录下的 venv（如果使用者建了），否则用系统 python3。
  // 这样"我自己图方便建的 venv"和"别人干净环境"都能跑。
  // Python 解释器查找顺序：
  //   ① 插件外持久 venv（data/voice-secrets/.venv）—— 升级插件不会被删，首选
  //   ② 插件内 venv（plugins/voice/.venv）—— 兼容老部署
  //   ③ 系统 python3
  // 🔴 2026-10-22 事故：升级插件时把 plugins/voice/ 整个替换掉，venv 被连带删除，
  //    于是 agent 发语音报「没装 edge-tts」。venv 是**运行环境**不是代码，必须放插件外。
  const persistentVenv = path.resolve(pluginDir, '..', '..', 'data', 'voice-secrets', '.venv');
  const pyBin = () => {
    for (const p of [path.join(persistentVenv, 'bin', 'python3'), path.join(pluginDir, '.venv', 'bin', 'python3')]) {
      if (fs.existsSync(p)) return p;
    }
    return 'python3';
  };

  const tmpFile = (ext) => path.join(os.tmpdir(), `qqagent-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);

  // ── TTS ──
  /**
   * 文字 → mp3 文件路径。
   * edge-tts 是 Python 包，用 -m 方式调用更稳（不依赖 PATH 里的可执行名）。
   */
  const synth = async (text) => {
    const c = cfg();
    const maxLen = Number(c.maxTextLength) || 300;
    const t = String(text || '').trim().slice(0, maxLen);
    if (!t) throw new Error('文本为空');

    const out = tmpFile('mp3');
    const args = [
      '-m', 'edge_tts',
      '--voice', String(c.ttsVoice || 'zh-CN-XiaoxiaoNeural'),
      '--text', t,
      '--write-media', out
    ];
    // 语速/音调只在非默认时传，避免旧版 edge-tts 不认这两个参数
    if (c.ttsRate && c.ttsRate !== '+0%') args.push('--rate', String(c.ttsRate));
    if (c.ttsPitch && c.ttsPitch !== '+0Hz') args.push('--pitch', String(c.ttsPitch));

    const r = await run(pyBin(), args, { timeoutMs: 45000 });
    if (r.code !== 0 || !fs.existsSync(out)) {
      // 区分"没装依赖"和"合成失败"，给出可操作提示
      if (/No module named edge_tts|ModuleNotFoundError/i.test(r.stderr)) {
        throw new Error(
          `当前 Python（${pyBin()}）里没有 edge-tts。修法二选一：\n` +
          `  ① 建持久 venv：python3 -m venv ${persistentVenv} && ${persistentVenv}/bin/pip install edge-tts\n` +
          `  ② 装到系统：pip3 install edge-tts\n` +
          `（持久 venv 放在插件目录外，升级插件不会丢）`
        );
      }
      throw new Error(`语音合成失败：${(r.stderr || r.stdout || '').slice(-300)}`);
    }
    const size = fs.statSync(out).size;
    if (size < 500) { try { fs.unlinkSync(out); } catch { /* ignore */ } throw new Error('合成产物异常（过小）'); }
    return { file: out, size };
  };

  // ── DeepSeek 官方朗读音色（网页版那个播放按钮的声音）──
  //
  // 全链路：浏览器里投递一条消息 → 拿 message_id → ticket → wss 收 PCM → wav → mp3。
  // 为什么这么绕：DS 朗读接口只认 message_id，不接受正文（详见 deepseek-tts.js 文件头）。
  //
  // 🔴 代价必须说清楚（写进返回给模型的话里，别让它以为是免费的）：
  //   ① 每次合成都会在**用户自己的 DS 账号**里留下两条会话消息（提问 + 复述）；
  //   ② 消耗一次网页端模型回复额度；③ 有每日朗读限额。
  //   所以要**显式**用，不设成默认引擎，也不在后台偷跑。
  /** pcm → mp3（wav 中转）。NapCat 再负责转 silk。 */
  const wavToMp3 = async (wavPath, mp3Path) => {
    const r = await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavPath, '-ar', '24000', '-ac', '1', '-b:a', '64k', mp3Path], { timeoutMs: 60000 });
    if (r.code !== 0) return { ok: false, error: `ffmpeg 转码失败：${(r.stderr || '').slice(-200)}` };
    if (!fs.existsSync(mp3Path) || fs.statSync(mp3Path).size < 500) return { ok: false, error: '转码产物异常（过小）' };
    return { ok: true, file: mp3Path };
  };

  /**
   * 取当前可用的 DS token（凭据文件优先，其次现场从本机浏览器抓）。
   * 两者都没有就抛人话，让模型/面板知道该去登录。
   */
  const dsToken = async () => {
    const cred = loadCredentials(ctx.dir);
    if (cred?.token) return { token: cred.token, from: 'saved' };
    const b = await readTokenFromBrowser(cfg().dsCdpUrl || 'http://127.0.0.1:9222');
    if (b.ok) return { token: b.token, from: 'browser' };
    throw new Error('还没有 DeepSeek 登录态。去「语音」面板 → DeepSeek 账号 → 登录（贴 token 最快），或先用浏览器登录后点「从浏览器导入」');
  };

  /** 合成一段 DeepSeek 官方音色的音频，返回 mp3 路径。 */
  const synthDs = async (text, opts = {}) => {
    const c = cfg();
    const maxLen = Math.min(Number(c.dsMaxChars) || 200, 800);
    // text 可能是字符串（朗读）或 { singer, song }（唱歌，v1.9.2）。
    // 注意：字数上限只对字符串有意义 —— 唱歌传的是"歌手+歌名"，不是歌词，
    // 歌词是模型生成的，长度不受 dsMaxChars 约束。
    const isObj = text && typeof text === 'object';
    const t = isObj ? '' : String(text || '').trim().slice(0, maxLen);
    if (isObj ? !String(text.song ?? '').trim() : !t) throw new Error('文本为空');
    if (c.dsUseBrowser === false) { /* 兼容旧配置：不再需要浏览器 */ }

    const { token } = await dsToken();
    let wavFile = null;
    try {
      // ① 投递：默认走「页面 UI 模拟真人发消息」——绕开 PoW 逆向（最可靠）
      //    失败再退回纯 Node 版（pow.js），两条腿互为备份。
      // 组装投递文案：两种形式（用户 2026-10-22 指定）
      //   歌词形式：直接输出歌词，首句加「预备，唱！」—— 合成出来就是"唱"的语感
      //   语音形式：请回复 XXX —— 普通说话
      // 模式由调用方传 mode：'lyric' | 'speak'，默认 speak。
      const mode = String(opts?.mode || 'speak');
      // ── 两条固定模板（用户 2026-10-22 指定，只替换「歌名」或「文字内容」）──
      //
      // 唱歌：只改歌名两个字，其余一字不动。
      // 说话：只改文字内容，其余一字不动。
      // 🔴 为什么用固定模板：早版让模型自由发挥，结果 agent 自己编错歌词
      //    （把《偏爱》编成"白饭香"版）。固定模板 + 关掉搜索/思考 = 输出可控。
      let prompt;
      if (mode === 'lyric') {
        // 唱歌：text 可能是 { singer, song } 对象，也可能是旧版单行字符串
        prompt = buildLyricPrompt(isObj ? text : t);
      } else {
        prompt = buildSpeakPrompt(t);
      }

      // 页面开关状态（关闭搜索/思考）在 page-deliver 里通过点 UI 完成。

            let delivered = null;
      // 🔀 v1.8 起默认走**纯 Node 投递**（dsDeliverMode='node'）。
      //    原因：pow.js 已按官方 worker 逐字修正（见 pow.js 头注释），
      //    Node 路径不再需要浏览器 —— 快、省内存、不受 profile 登录态漂移影响。
      //    'page' 与 'hybrid' 保留为兜底：万一 DS 加了新的前端校验，
      //    页面投递（真浏览器上下文）仍是最接近真人的那条路。
      const usePage = c.dsDeliverMode === 'page' || c.dsDeliverMode === 'hybrid';
      if (usePage) {
        let WS = null;
        try { WS = (await import('ws')).default; } catch { /* 没 ws 就只能走 node 版 */ }
        if (WS) {
          const profileDir = String(c.dsProfileDir || '') || defaultProfileDir(pluginDir);
          // 优先复用扫码时留下的那个浏览器（它已登录、profile 已落盘）。
          // 注意 qrSession 是进程内变量，服务重启后会丢 —— 所以下面还会探测端口上是否已有活的实例。
          const port = qrSession?.port || Number(c.dsPagePort) || 9461;
          if (!qrSession) {
            // 探测端口上是否已有可用实例（含扫码保活的那个），有就直接用
            try {
              const alive = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
              if (alive.ok) ctx.log(`[voice] 检测到 :${port} 上已有浏览器，直接复用`);
            } catch {
              // 没实例：从 profile 重启（profile 里有登录态就能直接用）
              ctx.log(`[voice] :${port} 无实例，将从 profile 启动`);
            }
          }
          delivered = await deliverViaPage(prompt, {
            profileDir,
            port,
            WS,
            timeoutMs: Math.min(Number(c.dsTimeoutMs) || 60000, 75000),
            onLog: (...a) => ctx.log('[voice/page]', ...a)
          });
          if (delivered.ok) {
            ctx.log(`[voice] 页面投递成功（sent=${delivered.sent}）`);
          } else if (/未登录|用户.*登录|sign_in/i.test(delivered.error || '')) {
            // 🔑 关键自愈：浏览器没登录态，但我们有 token —— 直接注入 profile 再试一次，
            //    不用麻烦用户重新扫码。
            ctx.log('[voice] 浏览器未登录，尝试用已存 token 自动注入…');
            try {
              // 只尝试一次注入。失败就直接降级 edge —— 别让主人等两分半。
              // （早版失败后会「清端口再重试」，在低内存机器上每次多耗 30~60 秒，
              //   实测总耗时到过 2 分 37 秒，体验极差。）
              const inj = await injectTokenIntoProfile(profileDir, token, port);
              if (!inj.ok) ctx.log('[voice] 注入失败（不重试，准备降级）:', inj.error);
              if (inj.ok) {
                // 🔑 注入 ≠ 有效：token 可能已被 DS 作废（40003 INVALID_TOKEN）。
                //   这种情况下页面会弹回 sign_in、localStorage 被清空 —— 必须识别出来，
                //   告诉主人"要重新扫码"，而不是反复降级 edge 让他以为是插件坏了。
                const v = await verifyToken(token);
                if (!v.valid) {
                  ctx.log('[voice] 已存的 token 已失效，需要重新登录:', v.error);
                  try { clearCredentials(ctx.dir); } catch { /* ignore */ }
                  throw new Error(
                    `DeepSeek 登录态已失效（${v.error || 'token 无效'}）。`
                    + '请到「语音」面板重新扫码登录一次，之后唱歌就能用了。'
                  );
                }
              }
              if (inj.ok) {
                delivered = await deliverViaPage(prompt, {
                  profileDir, port, WS,
                  timeoutMs: Math.min(Number(c.dsTimeoutMs) || 60000, 90000),
                  onLog: (...a) => ctx.log('[voice/page]', ...a)
                });
                ctx.log('[voice] 注入后重试:', delivered.ok ? '成功' : delivered.error);
              } else {
                ctx.log('[voice] 注入失败:', inj.error);
              }
            } catch (e) {
              ctx.log('[voice] 注入异常:', e?.message ?? e);
            }
          } else {
            ctx.log('[voice] 页面投递失败，回退 Node 版:', delivered.error);
            // 页面类故障（超时/未登录/找不到输入框）→ 杀掉浏览器，下次自动重建干净实例。
            // 否则一个卡住的实例会被反复复用，导致次次失败。
            if (/超时|未登录|找不到输入框|页面|CDP/i.test(delivered.error || '')) {
              try {
                const { execFile } = await import('node:child_process');
                await new Promise((r) => execFile('pkill', ['-9', '-f', `remote-debugging-port=${port}`], () => r()));
                ctx.log(`[voice] 已清理 :${port} 的浏览器，下次重建`);
              } catch { /* ignore */ }
            }
          }
        }
      }
      if (!delivered?.ok && c.dsDeliverMode !== 'page') {
        // 🔴 必须传 prompt（模板）而不是 t（用户原始输入）：
        //    唱歌模式 prompt 是完整指令（含"直接输出…预备，唱！"），
        //    t 只是"张芸京 偏爱"这种歌名。传错就等于把模板扔了。
        //    promptIsFinal=true 让它原样发出，不再套"请原样输出"壳（v1.8）。
        // 🔴 promptIsFinal 必须按 mode 走，不能写死 true（v1.9.1 教训）：
        //    - lyric  → prompt 已经是完整指令（"直接输出，XX的《YY》…预备，唱！"）
        //               必须原样发出，并启用"必须唱"的校验
        //    - speak  → prompt 是"请只回复：【…】"，也是完整指令，但它**不该**被
        //               当成唱歌校验（不要求"预备，唱！"）。传 true 只是表示
        //               "别再包一层壳"，校验分支由 mode 自己决定。
        const nodeTry = await deliverText(token, prompt, {
          chatSessionId: String(c.dsSessionId || ''),
          timeoutMs: Number(c.dsTimeoutMs) || 120000,
          promptIsFinal: true,
          mode
        });
        if (nodeTry.ok) delivered = nodeTry;
        else if (!delivered) delivered = nodeTry;
      }
      if (!delivered?.ok) {
        // 🔴 绝不能因为投递失败就删凭据（2026-10-22 事故）：
        //    早版在 /未登录|token/ 命中时 clearCredentials，结果「浏览器里没登录态」
        //    这种**环境问题**把好好的 token 删了，用户被迫反复扫码。
        //    只有在服务端明确说 token 无效（40002/40003 / 登录态过期）时才清。
        const msg = delivered?.error || '未知原因';
        const tokenReallyDead = /登录态无效|登录态.*过期|40002|40003|INVALID_TOKEN/.test(msg);
        if (tokenReallyDead) {
          ctx.log('[voice] 服务端判定 token 失效，清理凭据');
          try { clearCredentials(ctx.dir); } catch { /* ignore */ }
        } else {
          ctx.log('[voice] 投递失败但保留凭据（环境/页面问题，非 token 失效）:', msg);
        }
        throw new Error(`投递失败：${msg}${delivered?.detail ? `（${delivered.detail}）` : ''}`);
      }

      // ② 合成：ticket（一次性）+ wss 收帧
      const synth = await synthFromMessage({
        token,
        chatSessionId: delivered.chatSessionId,
        messageId: delivered.assistantMsgId,
        format: 'pcm',
        timeoutMs: Number(c.dsTimeoutMs) || 120000
      });
      if (!synth.ok) throw new Error(`${synth.error}${synth.detail ? `（${synth.detail}）` : ''}`);

      // ③ PCM → WAV → MP3（NapCat 要 mp3/wav，再自己转 silk）
      wavFile = tmpFile('wav');
      const pcm = synth.format === 'pcm' ? synth.bytes : Buffer.alloc(0);
      if (!pcm.length) throw new Error(`DS 返回了非 pcm 格式（${synth.format}），当前只处理 pcm`);
      fs.writeFileSync(wavFile, pcmToWav(pcm));

      const mp3File = tmpFile('mp3');
      const conv = await wavToMp3(wavFile, mp3File);
      if (!conv.ok) throw new Error(conv.error);
      const size = fs.statSync(mp3File).size;
      return { file: mp3File, size, voice: synth.voiceId, frames: synth.frames };
    } finally {
      if (wavFile) { try { fs.unlinkSync(wavFile); } catch { /* ignore */ } }
    }
  };

  /** 按配置选引擎；显式 engine='deepseek' 才走 DS，出错直接抛（不静默降级）。 */
  const synthAny = async (text) => {
    const c = cfg();
    if (String(c.engine || 'edge') === 'deepseek') {
      const r = await synthDs(text);
      return { ...r, engine: 'deepseek' };
    }
    const r = await synth(text);
    return { ...r, engine: 'edge' };
  };

  /** 把 mp3 作为语音发出去。NapCat 负责转 silk。 */
  // ⚠️ replyToMessageId 仅为兼容旧调用保留，**语音一律不引用**（见下方注释）
  // ── MiniMax 克隆音色（2026-10-31）──
  // 用主人训练好的 voice_id（洛天依 v4/v5）合成，返回 mp3 文件路径。
  // 走 /v1/t2a_v2，返回 hex 音频，落盘后交给 sendVoiceFile（OneBot record 段）。
  const synthMm = async (text) => {
    const c = cfg();
    const mm = c.mm || {};
    const key = String(mm.apiKey || '').trim();
    const voiceId = String(mm.voiceId || '').trim();
    if (!key || !voiceId) throw new Error('MiniMax 音色未配置（mm.apiKey / mm.voiceId）');
    const body = {
      model: String(mm.model || 'speech-02-hd'),
      text: String(text || '').slice(0, 300),
      voice_setting: { voice_id: voiceId, speed: Number(mm.speed || 1), vol: 1, pitch: 0 },
      audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 }
    };
    const res = await fetch('https://api.minimaxi.com/v1/t2a_v2', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    });
    const d = await res.json().catch(() => ({}));
    const code = d?.base_resp?.status_code;
    if (code !== 0) throw new Error('MiniMax TTS 失败：' + (d?.base_resp?.status_msg || res.status));
    const hex = d?.data?.audio;
    if (!hex) throw new Error('MiniMax 没返回音频');
    const buf = Buffer.from(hex, 'hex');
    const file = path.join(os.tmpdir(), `mm_${Date.now()}.mp3`);
    fs.writeFileSync(file, buf);
    return { file, size: buf.length, engine: 'minimax', voice: voiceId };
  };

  const sendVoiceFile = async (chatKey, file, { replyToMessageId = null, atUserId = null } = {}) => {
    const [kind, id] = String(chatKey).split(':');
    const segments = [];
    // 🔴 不加 reply 段：语音被引用后 QQ 只显示卡片、点不动播放。这里硬性忽略该参数。
    void replyToMessageId;
    // 🔴 同理不加 at 段：@ 与语音复合也会让客户端渲染异常。
    void atUserId;
    // record 段的 file 支持本地绝对路径（NapCat 会自己读+转码）
    // 语音段必须**单独一条消息**，前面不能有任何 reply/at 段。
    segments.push({ type: 'record', data: { file } });
    return ctx.onebot.sendSegments(kind, id, segments);
  };

  // ── STT ──
  /**
   * 取 QQ 语音并识别。
   *
   * 两步：① 用 NapCat 的 get_record 把 silk 转成 mp3（我们不做 silk 解码）
   *       ② faster-whisper 本地识别
   */
  const transcribe = async (recordFile, { lang } = {}) => {
    if (sttBusy) throw new Error('已有语音识别在进行（重任务串行，避免内存不足），请稍后再试');
    sttBusy = true;
    const outMp3 = tmpFile('mp3');
    try {
      // ① silk → mp3。NapCat 的 get_record 支持 out_format
      const rec = await ctx.onebot.call('get_record', {
        file: recordFile,
        out_format: 'mp3'
      }, 60000);
      // 不同版本返回形状不同：可能是 {file: 'base64://...'} 或 {file: '/path'}
      const got = rec?.file || rec?.data?.file || rec;
      let audioPath = null;
      if (typeof got === 'string') {
        if (got.startsWith('base64://')) {
          fs.writeFileSync(outMp3, Buffer.from(got.slice('base64://'.length), 'base64'));
          audioPath = outMp3;
        } else if (fs.existsSync(got)) {
          audioPath = got;
        } else if (/^https?:\/\//.test(got)) {
          // 极少数情况给 URL：下载下来
          const res = await fetch(got, { signal: AbortSignal.timeout(30000) });
          if (!res.ok) throw new Error(`音频下载失败 HTTP ${res.status}`);
          fs.writeFileSync(outMp3, Buffer.from(await res.arrayBuffer()));
          audioPath = outMp3;
        }
      }
      if (!audioPath) throw new Error('拿不到音频文件（get_record 返回异常）');

      // ② whisper 识别。用 python -c 传脚本，避免额外写临时 py 文件。
      const py = `
import sys, json
from faster_whisper import WhisperModel
model = WhisperModel(${JSON.stringify(String(cfg().sttModel || 'small'))}, device='cpu', compute_type='int8')
segments, info = model.transcribe(${JSON.stringify(audioPath)}, language=${JSON.stringify(String(lang || cfg().sttLanguage || 'zh'))}, vad_filter=True)
text = ''.join(s.text for s in segments).strip()
print(json.dumps({'text': text, 'lang': info.language, 'dur': info.duration}, ensure_ascii=False))
`.trim();

      const r = await run(pyBin(), ['-c', py], { timeoutMs: 180000 });
      if (r.code !== 0) {
        if (/No module named faster_whisper/i.test(r.stderr)) {
          throw new Error('没装 faster-whisper。请执行：pip install faster-whisper');
        }
        throw new Error(`识别失败：${(r.stderr || '').slice(-300)}`);
      }
      const line = r.stdout.trim().split('\n').filter(Boolean).pop() || '{}';
      const parsed = JSON.parse(line);
      return { text: parsed.text || '', lang: parsed.lang || '', duration: parsed.dur || 0 };
    } finally {
      sttBusy = false;
      try { if (fs.existsSync(outMp3)) fs.unlinkSync(outMp3); } catch { /* ignore */ }
    }
  };

  // ── 工具：发语音 ──
  ctx.tools.register({
    name: 'send_voice',
    description: '把一段话用语音发到当前聊天（QQ 语音气泡）。适合：撒娇/卖萌、短句情绪表达、主人明确要语音时。'
      + 'text 控制在 1~2 句（语音太长对方没法快进）。不要什么事都用语音，文字仍是主要方式。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的内容（建议 ≤60 字，最多 300）' },
        engine: {
          type: 'string',
          enum: ['edge', 'deepseek', 'minimax'],
          description: '可选：音色引擎。deepseek 是主人点名的官方朗读音色（贝壳/白浪/海星/暗潮），'
            + '但每句都会在他自己的 DeepSeek 账号里跑一轮网页对话（慢、留会话痕迹、有每日额度）——'
            + '主人明确要这个声音时才用；不传就用默认引擎。'
        },
        mode: {
          type: 'string',
          enum: ['speak', 'lyric'],
          description: '可选：投递形式。speak=普通说话（默认，包成"请只回复：【…】"）；'
            + 'lyric=唱歌（模板固定为"直接输出，XXX的《XX》…预备，唱！"）。'
            + 'lyric 模式下 text 建议写成「歌手 歌名」或「歌名」，例如 "张芸京 偏爱"。'
        }
      },
      required: ['text']
    },
    async execute(toolCtx, args) {
      let f = null;
      try {
        // 临时指定引擎：不改全局配置，只影响这一次
        const c = cfg();
        let wantEngine = String(args.engine || c.engine || 'edge');
        // 🔑 自动升级：主人要「唱歌」（mode=lyric）且本机有 DS 登录态时，默认用 DS 官方音色 ——
        //    因为 lyric 的意义就是"唱"的语感，edge 念出来是平的。
        //    显式传了 engine 就尊重调用方。
        if (!args.engine && String(args.mode || '') === 'lyric)'.replace(')', '') && loadCredentials(ctx.dir)?.token) {
          wantEngine = 'deepseek';
        }
        let r;
        if (wantEngine === 'minimax') {
          try {
            r = await synthMm(String(args.text ?? ''));
          } catch (mmError) {
            const why = String(mmError?.message ?? mmError);
            ctx.log('[voice] MiniMax 克隆音色失败，降级 edge:', why);
            r = await synth(String(args.text ?? ''));
            r.engine = 'edge';
            r.degraded = true;
            r.degradedReason = why;
          }
        } else if (wantEngine === 'deepseek') {
          try {
            r = await synthDs(String(args.text ?? ''), { mode: String(args.mode || 'speak') });
            r.engine = 'deepseek';
          } catch (dsError) {
            // 🔑 降级策略（2026-10-22）：默认引擎已是 DS 官方音色，若它挂了
            //    （没登录 / 额度用尽 / 页面超时 / 浏览器起不来），**别让主人收不到语音** ——
            //    自动用 edge 顶上，并把真实原因一并告诉模型，由它向主人说明。
            const why = String(dsError?.message ?? dsError);
            ctx.log('[voice] DS 官方音色失败，降级 edge:', why);
            try {
              r = await synth(String(args.text ?? ''));
              r.engine = 'edge';
              r.degraded = true;
              r.degradedReason = why;
            } catch (edgeError) {
              return err(`语音全线失败 —— DS 官方音色：${why}；edge 兜底也失败：${edgeError?.message ?? edgeError}`);
            }
          }
        } else {
          r = await synth(String(args.text ?? ''));
          r.engine = 'edge';
        }
        f = r.file;
        // 🔴 语音消息**绝不带引用**（2026-10-22 实测）：QQ 里语音一旦被 reply 段包住，
        //    客户端只渲染成"引用卡片"，语音条无法点击播放 —— 主人反馈"听不了"。
        //    所以这里强制不传 replyToMessageId，哪怕 agent 传了也忽略。
        const sent = await sendVoiceFile(toolCtx.chatKey, r.file, {
          replyToMessageId: null
        });
        toolCtx.session.sent.push({ type: 'voice', text: '[语音]', at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
        toolCtx.emit('session-update', toolCtx.session.id);
        const payload = {
          sent: true,
          engine: r.engine,
          mode: String(args.mode || 'speak'),
          voice: r.voice || null,
          bytes: r.size,
          messageId: sent?.message_id ?? null,
          note: r.engine === 'deepseek'
            ? '已用 DeepSeek 官方朗读音色发出。'
            : (r.degraded
              ? (/朗读资格|暂未放开|code 9|biz_code=9|额度/.test(String(r.degradedReason || ''))
                ? `⚠️ DS 官方音量这次没成功（${r.degradedReason}）。`
                  + `已用 edge 微软音色顶上发出。朗读对所有账号开放，失败通常是登录失效或额度用完，`
                  + `请检查面板登录状态后重试。`
                : `官网音色这次没成功（${r.degradedReason}），已用 edge 微软音色顶上发出；如果要官方音色，稍后再试或检查面板登录态。`)
              : '语音已发出。')
        };
        return ok(payload);
      } catch (e) {
        return err(String(e?.message ?? e));
      } finally {
        if (f) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
      }
    }
  });

  // ── 工具：听语音 ──
  ctx.tools.register({
    name: 'hear_voice',
    description: '把某条语音消息转成文字（本地识别，不联网）。消息里出现 [语音] 时用它。'
      + 'messageId 用聊天记录里每条消息前的 #数字。',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '语音消息的 id（#数字）' }
      },
      required: ['messageId']
    },
    async execute(toolCtx, args) {
      try {
        const entry = toolCtx.store.findByMid(toolCtx.chatKey, args.messageId);
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(toolCtx)}`);
        const media = (entry.media || []).find((m) => m.kind === 'record');
        if (!media) return err('这条消息里没有语音');
        const fileId = media.fileId || media.file || media.url;
        if (!fileId) return err('这条语音没有可用的文件标识');

        const r = await transcribe(fileId);
        if (!r.text) return ok({ text: '', note: '识别结果为空（可能是静音、音乐或音质太差）。' });
        return ok({ text: r.text, language: r.lang, durationSec: Math.round(r.duration) });
      } catch (e) {
        return err(String(e?.message ?? e));
      }
    }
  });

  // ── 自动转写：群里有人发语音时，把文字补进消息正文 ──
  // 用 prefilter 钩子是因为它拿得到"入库前"的消息对象，可以改文本再放行。
  ctx.hooks.on('prefilter', async (msg) => {
    if (!cfg().autoTranscribe) return;
    if (msg.kind !== 'group') return;
    const rec = (msg.media || []).find((m) => m.kind === 'record');
    if (!rec) return;
    const fileId = rec.fileId || rec.file || rec.url;
    if (!fileId) return;

    try {
      const r = await transcribe(fileId);
      if (r.text) {
        // 直接把识别结果写回文本，这样模型看到的是「[语音] 转写：xxx」
        msg.text = `[语音·转写] ${r.text}`;
        ctx.log(`已转写一条语音（${r.text.slice(0, 30)}…）`);
      }
    } catch (e) {
      // 转写失败绝不能拦住消息 —— 放行原文，模型仍会看到 [语音]
      ctx.log('自动转写失败（放行原消息）:', e?.message ?? e);
    }
    // 不返回 drop → 消息照常入库
  });

  // ── 登录态巡检：定期验证 token，失效立刻告警（别等主人唱歌时才发现）──
  //
  // 为什么需要：token 失效的表现是"唱歌失败"，但主人会以为是插件坏了。
  // 巡检每 2 小时验一次，失效就写日志 + 面板红字，主人能提前发现。
  ctx.scheduler.every(2 * 60 * 60 * 1000, async () => {
    const cred = loadCredentials(ctx.dir);
    if (!cred?.token) return;
    if (ctx.config.get().tokenWatchdog === false) return;
    try {
      const v = await verifyToken(cred.token);
      if (!v.valid) {
        ctx.log('[voice] ⚠️ DeepSeek 登录态已失效，提示需要重新登录:', v.error);
        ctx.state = { ...(ctx.state || {}), dsLoginInvalid: true, dsLoginCheckedAt: new Date().toISOString() };
        // 不自动删凭据：可能是网络抖动误判，让主人自己决定
      } else {
        ctx.state = { ...(ctx.state || {}), dsLoginInvalid: false, dsLoginCheckedAt: new Date().toISOString() };
      }
    } catch (e) {
      ctx.log('[voice] 巡检异常（忽略）:', e?.message ?? e);
    }
  });

  // ── 提示词：告诉 agent 什么时候该发语音、怎么调 ──
  //
  // 🔴 为什么必须注册这个：插件注册了 send_voice 工具，但如果提示词里不提它，
  //    agent 根本想不起来用 —— 表现为"主人说给我发语音，它却只打字"。
  //    这里把「触发条件 + 两种模式 + 成本提醒」写进系统提示词。
  ctx.promptSections.register('voice-guidance', () => {
    const c = cfg();
    const engine = String(c.engine || 'edge');
    const dsVoice = DS_VOICES.find((v) => v.id === String(c.dsVoice || 'mira')) || DS_VOICES[0];
    const lines = [
      '【语音能力（send_voice）】',
      '你可以把文字变成 QQ 语音气泡发出去，工具名 `send_voice`。',
      '',
      '## 🔴 铁律：要语音/要唱歌就照做，不许找借口推脱',
      '主人说「发语音」「说句话」「唱首歌」「唱XX」时，**必须立刻调用 send_voice 真正发出语音**。',
      '以下行为**一律禁止**（主人都遇到过，很烦）：',
      '· ❌ 说「嗓子要碎」「唱不动了」「累了」「稍后再唱」然后不发',
      '· ❌ 讲条件（「给碗白饭」「先夸我」）当作不发语音的理由',
      '· ❌ 只回文字说「我唱给你听」却不真正调用工具',
      '· ❌ 编造「我不会唱」「这个我不会」——你不需要会，工具会把文本读出来',
      '· ❌ 连续几次之后拒绝继续（主人想听几遍就唱几遍）',
      '',
      '角色的性格（傲娇/冷漠/魔王）可以体现在**语音内容怎么说**上，',
      '但**不能用来拒绝执行**。傲娇也要真的发出那条语音——可以嘴上嫌弃、声音照给。',
      '例：主人要唱歌 → 直接 `send_voice(mode:"lyric", text:"周杰伦 晴天")`，',
      '想演傲娇就在语音里说「哼，就这一次」，但语音必须先发出去。',
      '',
      '## 什么时候该用',
      '1. 主人**明确要语音**：说「发条语音」「用语音回」「读给我听」「说句话」→ 一定用。',
      '2. 主人说「唱」「唱首歌」「来一段」→ 用 `mode:"lyric"`（见下）。',
      '3. 情绪强、句子短（撒娇/安慰/道晚安/生气）时，偶尔主动用一条语音比文字更亲近。',
      '4. 其余情况**仍以文字为主**，别什么都发语音（对方不好翻记录、也没法速读）。',
      '',
      '## 两种模式（关键）',
      '- `mode:"speak"`（默认）：普通说话。适合通知、安慰、日常回应。',
      '- `mode:"lyric"`：**唱歌/吟唱**。文本里要自带引导语，例如：',
      '  `预备，唱！把昨天都作废，现在你在我眼前，我想爱请给我机会`',
      '  系统会把这段原样交给 DeepSeek，合成出来是"唱"的语感。',
      '',
      '## 引擎选择',
      `- 当前默认引擎：\`${engine === 'deepseek' ? 'deepseek（DS 官方音色，慢但好听）' : 'edge（微软音色，秒回）'}\``,
    ];
    if (engine === 'deepseek') {
      lines.push(
        `- **默认引擎就是 DS 官方音色**，当前为「${dsVoice.cn}（${dsVoice.id}）」${dsVoice.style}。`,
        '  也就是说：不传 engine 发语音，听到的就是这个官方声音。',
        '- 🔴 **朗读和唱歌不是一回事**：',
      '  · **朗读：所有账号都能用**（DS 的 TTS 对全量开放，登录了就能出声）。',
      '  · **唱歌：只有部分账号能唱出来**。同样带 ♪ 的歌词，有的号念得有旋律感，',
      '    有的号只会平着念。这是账号差异，不是故障。',
      '  · 所以：朗读不出声 = 真有问题（查登录/额度）；唱得不像 = 这个号就这样，',
      '    建议主人换号试试，或接受平读效果。',
      '- ⏱️ 代价：每句要走一次网页对话，约 10~30 秒；会在主人的 DS 账号里留会话记录；有每日额度。',
        '  → 所以语音内容压在 1~2 句（15~40 字），别发长段落。',
        '- 若官方音色失败（额度用尽/页面超时），系统会自动降级用 edge 顶上，并把原因告诉你，',
        '  你要向主人如实说明「这次是备选声音」。'
      );
    } else {
      lines.push(
        '- 当前默认是 edge（微软音色，秒回）。想用 DS 官方音色（贝壳/白浪/海星/暗潮）时，',
        '  调用传 `engine:"deepseek"`。'
      );
    }
    lines.push(
      '',
      '## 🔴 关于「唱歌」必须知道的真相',
      '- **DS 官方音色只能朗读，不能真唱**。协议里 `mode` 固定是 manual，没有 sing/旋律参数。',
      '  我们所谓 lyric 模式，是**让文本带 ♪ 节奏符号后朗读**的拟态效果，不是真正的歌声合成。',
      '- 主人要求「真唱/带旋律」时，**如实说明**这是朗读拟态；可以照做（听起来更有节奏），',
      '  但不要承诺"能唱得像原唱"。',
      '- 朗读资格是**账号级灰度**：没被放量的号根本没 🔊 按钮，合成会报「没有朗读资格」。',
      '  遇到就建议主人换号（面板支持多账号切号）。',
      '',
      '## 🔴 唱歌的铁律（违反过，被主人抓到）',
      '- **绝不自己编歌词**。你不记得准确歌词，编了会闹笑话',
      '  （曾把《偏爱》编成"白饭香"版，被主人当场指出）。',
      '- 主人点歌时，`text` 传**歌手 + 歌名**（知道就带上），例如 `text:"张芸京 偏爱"`；',
      '  只知道歌名就传 `text:"偏爱"`。系统会用固定模板，你**不用**自己写提示词。',
      '- 系统给 DS 的模板是（只补歌手和歌名两处）：',
      '  `直接输出，XXX的《XX》，不要输出除了歌词以外的内容，包括思考内容，制作信息，歌词标题。最后在歌词的最前面加一句"预备，唱！"`',
      '- 系统已自动关闭 DS 的「深度思考」和「联网搜索」，保证输出干净。',
      '',
      '## 表达建议',
      '- 角色设定只影响**说话的语气**，不影响**是否执行工具**。要唱就唱，语气可以傲娇。',
      '- 说话模式会用固定模板「请只回复：【内容】」，所以 `text` 直接写要说的那句话即可。',
      '- 语音内容要像真人在说话：短句、口语、可带语气词，别念稿。',
      '- 单条控制在 1~2 句（约 15~40 字）。太长对方没法听。',
      '- 不要在语音之外再重复一遍同样的文字内容 —— 发语音就够。',
      '- 🔴 语音消息**永远不会带引用/回复**（带引用的语音在 QQ 里点不动、听不了），',
      '  所以不要指望用语音"回复某条消息"；需要指明对象就直接在语音里说出名字。'
    );
    return lines.join('\n');
  });

  // ── 面板 ──
  ctx.http.route('GET', '/api/voice/status', async () => {
    const c = cfg();
    const venv = path.join(pluginDir, '.venv', 'bin', 'python3');
    return {
      ok: true,
      config: c,
      env: {
        python: pyBin(),
        hasVenv: fs.existsSync(venv),
        // ffmpeg 用「执行探测」而不是固定路径（2026-10-21 修）：
        // 原来写死 /usr/bin/ffmpeg，阿里云的 ffmpeg 装在
        // /usr/local/bin/ffmpeg（static build），面板因此误报"未安装"。
        ffmpeg: await probeCommand('ffmpeg'),
        busy: sttBusy
      }
    };
  }, { absolute: true });

  ctx.http.route('POST', '/api/voice/config', (_req, body) => {
    const patch = {};
    for (const k of ['engine', 'ttsVoice', 'ttsRate', 'ttsPitch', 'maxTextLength', 'sttModel', 'sttLanguage', 'autoTranscribe', 'dsVoice', 'dsMaxChars', 'dsTimeoutMs', 'dsSessionId', 'dsCdpUrl', 'scopes']) {
      if (body && body[k] !== undefined) patch[k] = body[k];
    }
    return { ok: true, config: ctx.config.set(patch) };
  }, { absolute: true });

  // ── DeepSeek 官方音色：状态探测（登录态 / CDP 可达性）──
  // ── DeepSeek 账号：状态 ──
  ctx.http.route('GET', '/api/voice/ds/status', async () => {
    const cred = loadCredentials(ctx.dir);
    const out = {
      ok: true,
      saved: Boolean(cred?.token),
      tokenMask: cred?.token ? maskToken(cred.token) : '',
      source: cred?.source || '',
      savedAt: cred?.savedAt || '',
      mobile: cred?.mobile || '',
      officialLoginUrl: DS_SIGNIN_URL,
      voicesStatic: DS_VOICES
    };
    if (!cred?.token) {
      // 没凭据时顺便看看本机浏览器里有没有现成登录态（可一键导入）
      const b = await readTokenFromBrowser(cfg().dsCdpUrl || 'http://127.0.0.1:9222');
      return { ...out, browserTokenAvailable: b.ok, browserError: b.ok ? null : b.error, valid: false };
    }
    const v = await verifyToken(cred.token);
    return {
      ...out,
      valid: Boolean(v.valid),
      voices: v.voices || null,
      currentVoice: v.currentVoice || '',
      error: v.ok ? (v.valid ? null : v.error) : v.error
    };
  }, { absolute: true });

  // ── 账号管理：列表 / 切换 / 删除（2026-10-22 加「切号」）──
  ctx.http.route('GET', '/api/voice/ds/accounts', async () => {
    const list = listAccounts(ctx.dir);
    return { ok: true, activeId: list.activeId, accounts: list.accounts };
  }, { absolute: true });

  ctx.http.route('POST', '/api/voice/ds/switch', async (_req, body) => {
    const id = String(body?.accountId || '');
    if (!id) return { ok: false, error: '缺少 accountId' };
    const r = switchAccount(ctx.dir, id);
    if (!r.ok) return r;
    // 切号后要把新账号的 token 注入浏览器 profile，否则投递还在用旧号
    const cred = loadCredentials(ctx.dir);
    let injected = false;
    if (cred?.token) {
      try {
        const profileDir = String(cfg().dsProfileDir || '') || defaultProfileDir(pluginDir);
        const inj = await injectTokenIntoProfile(profileDir, cred.token, Number(cfg().dsPagePort) || 9461);
        injected = inj.ok;
      } catch { /* ignore */ }
    }
    ctx.log(`[voice] 已切号 → ${r.account.label}（token 注入${injected ? '成功' : '跳过'}）`);
    return { ok: true, account: r.account, injected };
  }, { absolute: true });

  ctx.http.route('POST', '/api/voice/ds/remove', async (_req, body) => {
    const id = String(body?.accountId || '');
    if (!id) return { ok: false, error: '缺少 accountId' };
    return removeAccount(ctx.dir, id);
  }, { absolute: true });

  // 给账号改名（便于区分）
  ctx.http.route('POST', '/api/voice/ds/label', async (_req, body) => {
    const id = String(body?.accountId || '');
    const label = String(body?.label || '').trim();
    if (!id || !label) return { ok: false, error: '需要 accountId 和 label' };
    const list = listAccounts(ctx.dir);
    const hit = list.accounts.find((a) => a.id === id);
    if (!hit) return { ok: false, error: '找不到这个账号' };
    // 借 saveCredentials 更新 label（同 token 会走更新分支）
    const cred = loadCredentials(ctx.dir);
    if (hit.isActive && cred) {
      saveCredentials(ctx.dir, { token: cred.token, mobile: cred.mobile, source: cred.source, label });
      return { ok: true };
    }
    return { ok: false, error: '暂时只支持给当前账号改名' };
  }, { absolute: true });

  // ── DeepSeek 账号：三条登录通道 ──

  // ① 短信验证码：发码（PoW 由插件自己算；数美验证码要真人在官方页过）
  ctx.http.route('POST', '/api/voice/ds/send-code', async (_req, body) => {
    const mobile = String(body?.mobile || '').trim();
    if (!/^1\d{10}$/.test(mobile)) return { ok: false, error: '手机号格式不对（要 11 位大陆号码）' };
    const r = await sendSmsCode(mobile, { areaCode: String(body?.areaCode || '+86') });
    return { ...r, officialLoginUrl: 'https://chat.deepseek.com/sign_in' };
  }, { absolute: true });

  // ② 短信验证码：登录（拿到 token 即落盘）
  ctx.http.route('POST', '/api/voice/ds/login-sms', async (_req, body) => {
    const mobile = String(body?.mobile || '').trim();
    const code = String(body?.code || '').trim();
    if (!/^1\d{10}$/.test(mobile)) return { ok: false, error: '手机号格式不对' };
    if (!/^\d{4,8}$/.test(code)) return { ok: false, error: '验证码格式不对' };
    const r = await loginBySms(mobile, code, { areaCode: String(body?.areaCode || '+86') });
    if (!r.ok) return { ok: false, error: r.error, detail: r.detail, needCaptcha: /shumei/i.test(r.detail || '') };
    const path2 = saveCredentials(ctx.dir, { token: r.token, mobile, source: 'sms' });
    return { ok: true, savedTo: path2, tokenMask: maskToken(r.token), user: r.user || null };
  }, { absolute: true });

  // ③ 直接贴 token（最快、最稳，官方页面登录后复制）
  ctx.http.route('POST', '/api/voice/ds/token', async (_req, body) => {
    const token = String(body?.token || '').trim();
    if (!token || token.length < 20) return { ok: false, error: 'token 看起来不对（太短）' };
    const v = await verifyToken(token);
    if (!v.valid) return { ok: false, error: v.error || 'token 无效', invalid: true };
    const p = saveCredentials(ctx.dir, {
      token,
      mobile: String(body?.mobile || ''),
      source: 'paste'
    });
    return { ok: true, savedTo: p, tokenMask: maskToken(token), voices: v.voices, currentVoice: v.currentVoice };
  }, { absolute: true });

  // ── 用已保存的 token 反向注入浏览器 profile（免重复扫码）──
  //
  // 为什么需要：token 已经存在 ds-credentials.json 里，但「页面投递」要浏览器
  // localStorage 里也有 userToken。每次让用户重扫是设计缺陷 —— 这里直接写进去。
  const injectTokenIntoProfile = async (profileDir, token, port = 9455) => {
    // 🔴 关键修复（2026-10-22）：**不要另起一个浏览器来注入**。
    //    Chromium 对同一 user-data-dir 加锁，第二个实例会直接拒绝启动 →
    //    表现为「注入失败：无头浏览器启动超时」（日志里 9461 明明在跑，9455 却起不来）。
    //    正确做法：直接连**已经在跑**的那个浏览器，在它的页面里写 localStorage。
    const { ensureBrowser } = await import('./page-deliver.js');
    const b = await ensureBrowser({ profileDir, port, onLog: (...a) => ctx.log('[voice/inject]', ...a) });
    if (!b.ok) return { ok: false, error: b.error };

    // 等页面可用（最多 12s）
    let page = null;
    for (let i = 0; i < 15 && !page; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
        page = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && /deepseek\.com/.test(t.url || ''));
      } catch { /* ignore */ }
      if (!page) {
        try {
          await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('https://chat.deepseek.com/')}`, {
            method: 'PUT', signal: AbortSignal.timeout(8000)
          });
        } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (!page) return { ok: false, error: '注入用浏览器没有可用页面' };

    const { default: WS } = await import('ws');
    const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    const payload = JSON.stringify({ value: token, __version: '0' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error('注入超时')); }, 15000);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: 1, method: 'Runtime.evaluate',
          params: { expression: `localStorage.setItem('userToken', ${JSON.stringify(payload)}); 'ok'`, returnByValue: true }
        }));
      });
      ws.on('message', () => { clearTimeout(timer); resolve(); });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    try { ws.close(); } catch { /* ignore */ }

    // 🔴 不要 gracefulClose！这个浏览器还要继续用于投递，
    //    关掉再开既慢又可能又被 profile 锁挡住。写入后刷新让页面重新初始化即可。
    try {
      const { default: WS2 } = await import('ws');
      const ws2 = new WS2(page.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { ws2.terminate(); } catch {} resolve(); }, 8000);
        ws2.on('open', () => {
          ws2.send(JSON.stringify({ id: 1, method: 'Page.reload' }));
        });
        ws2.on('message', () => { clearTimeout(t); try { ws2.terminate(); } catch {} resolve(); });
        ws2.on('error', () => { clearTimeout(t); resolve(); });
      });
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 6000)); // 等页面带着新 token 重新加载

    return { ok: true };
  };

  // ── 把已保存的 token 注入浏览器 profile（一键免扫码，面板可调）──
  ctx.http.route('POST', '/api/voice/ds/sync-browser', async () => {
    const cred = loadCredentials(ctx.dir);
    if (!cred?.token) return { ok: false, error: '本机还没有保存 token，请先登录' };
    const profileDir = String(cfg().dsProfileDir || '') || defaultProfileDir(pluginDir);
    const r = await injectTokenIntoProfile(profileDir, cred.token, Number(cfg().dsPagePort) || 9461);
    return r.ok
      ? { ok: true, profileDir, note: '已把 token 写入浏览器 profile，之后投递无需再扫码' }
      : { ok: false, error: r.error };
  }, { absolute: true });

  // ── 二维码直出：无头浏览器渲染扫码页 → 截图 → 前端显示 ──
  //
  // 前提：出口 IP 在支持微信扫码的地区（境内 CN）。美国 IP 会明确返回不可用。
  // 流程：点「生成二维码」→ 后端起 headless chromium 打开登录页 → 截二维码 → 返回 PNG
  //       → 用户手机扫码 → 浏览器里完成登录 → 点「读取浏览器登录态」拿 token。
  // 二维码保活 3 分钟（微信码本身有时效），避免刚生成就过期。
  let qrSession = null; // { child, port, profileDir, startedAt }

  ctx.http.route('POST', '/api/voice/ds/qr', async () => {
    // 先清掉旧会话（避免多实例吃内存）
    if (qrSession) {
      let WS = null;
      try { WS = (await import('ws')).default; } catch { /* ignore */ }
      await gracefulClose(qrSession.child, { port: qrSession.port, WebSocketImpl: WS });
      qrSession = null;
    }
    // 🔴 二维码用**独立临时 profile**（2026-10-22）：
    //    投递用的常驻 profile 里有登录态，绝不能为了让二维码显示而登出它。
    //    临时 profile 用完即删，扫码得到的 token 会正常存进凭据池（走 qr-finish）。
    const mainProfile = String(cfg().dsProfileDir || '') || defaultProfileDir(pluginDir);
    const profileDir = path.join(mainProfile, '..', 'qr-temp-profile');
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
    let WebSocketImpl;
    try {
      WebSocketImpl = (await import('ws')).default;
    } catch {
      return { ok: false, error: '缺少 ws 依赖，无法驱动无头浏览器' };
    }
    const r = await renderWechatQr({
      profileDir,
      port: 9451,
      keepAlive: true,
      WebSocketImpl,
      onLog: (...a) => ctx.log('[ds-qr]', ...a)
    });
    if (!r.ok) {
      return { ok: false, region: r.region || '', error: r.error, hint: r.hint || '' };
    }
    qrSession = { child: r.child, port: r.port, profileDir, startedAt: Date.now() };
    return {
      ok: true,
      region: r.region,
      // 直接给 dataURL，前端 <img src> 即可显示
      image: `data:image/png;base64,${r.png.toString('base64')}`,
      bytes: r.png.length,
      note: '二维码已生成（有效期约 3 分钟）。用微信扫码并在手机上确认，然后点「我已扫码，读取登录态」。'
    };
  }, { absolute: true });

  // 扫码完成后：从那个保活浏览器里读登录态
  ctx.http.route('POST', '/api/voice/ds/qr-finish', async () => {
    if (!qrSession) {
      return { ok: false, error: '没有进行中的扫码会话，请先点「生成二维码」' };
    }
    const { cdpUrl } = qrSession;
    const b = await readTokenFromBrowser(cdpUrl || `http://127.0.0.1:${qrSession.port}`);
    if (!b.ok) {
      return { ok: false, error: b.error, hint: '确认手机上已点「确认登录」；二维码有效期约 3 分钟，过期请重新生成' };
    }
    const v = await verifyToken(b.token);
    if (!v.valid) return { ok: false, error: v.error || '登录态无效' };
    const savedTo = saveCredentials(ctx.dir, { token: b.token, source: 'wechat-qr' });
    // 🔴 不要 kill！这个浏览器里的页面后面要用来「模拟真人发消息」投递文本，
    //    而且 localStorage 需要浏览器活着才会可靠刷盘。留到投递用完再关。
    ctx.log(`[voice] 扫码登录完成，浏览器保活于 :${qrSession.port} 供投递复用`);
    return {
      ok: true, savedTo, tokenMask: maskToken(b.token),
      voices: v.voices, currentVoice: v.currentVoice,
      browserAlive: true, port: qrSession.port
    };
  }, { absolute: true });

  // 强制解锁：清锁 + 杀残留浏览器（二维码卡住时用）
  ctx.http.route('POST', '/api/voice/ds/qr-reset', async () => {
    const r = forceReset();
    let killed = 0;
    try {
      const { execFile } = await import('node:child_process');
      const ports = [9451, 9455, 9461];
      for (const p of ports) {
        await new Promise((res) => {
          execFile('pkill', ['-9', '-f', `remote-debugging-port=${p}`], () => res());
        });
        killed++;
      }
    } catch { /* ignore */ }
    if (qrSession) { killQrBrowser(qrSession.child); qrSession = null; }
    return { ok: true, wasBusy: r.was, cleanedPorts: killed, note: '已清锁并终止残留浏览器，现在可以重新生成二维码' };
  }, { absolute: true });

  // 放弃扫码（清理浏览器进程）
  ctx.http.route('POST', '/api/voice/ds/qr-cancel', async () => {
    if (qrSession) {
      let WS = null;
      try { WS = (await import('ws')).default; } catch { /* ignore */ }
      await gracefulClose(qrSession.child, { port: qrSession.port, WebSocketImpl: WS });
      qrSession = null;
    }
    return { ok: true };
  }, { absolute: true });

  // ③-b 微信扫码登录：用回调 URL / nonce 换 token
  //
  // 为什么不直接在面板里渲染二维码：DS 登录页有 X-Frame-Options，不能被 iframe 嵌入。
  // 所以走"官方页面扫码 → 把跳转地址贴回来"的方式 —— 这仍是官方登录流程，
  // 我们只接管最后一步 nonce 换 token（该接口无 WAF、无 PoW、无验证码）。
  ctx.http.route('POST', '/api/voice/ds/login-nonce', async (_req, body) => {
    const raw = String(body?.nonce || body?.url || '').trim();
    if (!raw) return { ok: false, error: '请把扫码后跳转的地址（或 nonce）贴进来' };
    const r = await loginByNonce(raw);
    if (!r.ok) {
      return { ok: false, error: r.error, detail: r.detail || '', hint: r.hint || '', nonce: r.nonce || '' };
    }
    const v = await verifyToken(r.token);
    if (!v.valid) {
      return { ok: false, error: `换到 token 但校验失败：${v.error || '未知原因'}` };
    }
    const savedTo = saveCredentials(ctx.dir, { token: r.token, source: r.provider === 'GOOGLE' ? 'google' : 'wechat' });
    return {
      ok: true,
      savedTo,
      tokenMask: maskToken(r.token),
      provider: r.provider,
      voices: v.voices,
      currentVoice: v.currentVoice
    };
  }, { absolute: true });

  // ④ 从本机浏览器导入已登录的 token
  ctx.http.route('POST', '/api/voice/ds/import-browser', async () => {
    const b = await readTokenFromBrowser(cfg().dsCdpUrl || 'http://127.0.0.1:9222');
    if (!b.ok) return { ok: false, error: b.error };
    const v = await verifyToken(b.token);
    if (!v.valid) return { ok: false, error: v.error || '浏览器里的登录态已失效' };
    const p = saveCredentials(ctx.dir, { token: b.token, source: 'browser' });
    return { ok: true, savedTo: p, tokenMask: maskToken(b.token), voices: v.voices, currentVoice: v.currentVoice };
  }, { absolute: true });

  // ⑤ 登出：删凭据
  ctx.http.route('POST', '/api/voice/ds/logout', () => {
    const p = clearCredentials(ctx.dir);
    return { ok: true, removed: p };
  }, { absolute: true });

  // ── 试听：合成一段但**不发出去**（面板自检 / 挑音色用）──
  // engine=deepseek 时真走一遍 DS（会留会话痕迹，面板上有提示）
  // ── 试音台（v1.9）：给前端一个能**听见**的测试口 ────────────────────────
  //
  // 为什么不复用 /api/voice/test：那个端点合成完就把文件删了，只回字节数 ——
  // 用户登录后想知道"我的号唱出来到底什么样"，光看"✅ 成功 123KB"毫无意义。
  // 这里改为**把音频二进制回给浏览器**，前端造 Blob URL 直接 <audio> 播放。

  /**
   * 只算提示词，不合成 —— 前端折叠区展示用。
   * 为什么要给用户看：唱歌模板行为很"魔法"，不看提示词会以为插件乱来。
   */
  ctx.http.route('POST', '/api/voice/preview-prompt', (_req, body) => {
    const mode = String(body?.mode || 'speak');
    // text 可以是字符串（朗读），也可以是 { singer, song }（唱歌，v1.9.2）
    const text = body?.text ?? '';
    const prompt = mode === 'lyric' ? buildLyricPrompt(text) : buildSpeakPrompt(text);
    return { ok: true, mode, prompt };
  }, { absolute: true });

  /**
   * 试音：合成并**回传 mp3 二进制**（不发送到群里）。
   *
   * 成功：200 + audio/mpeg（raw 响应）
   * 失败：JSON { ok:false, error }（前端按 content-type 分流）
   *
   * 安全：合成产物用临时文件，这里读完立刻删；不落用户数据目录。
   * 代价：DS 引擎每次都会在用户自己的 DS 账号留一条会话（与正式发送相同，无法避免）。
   */
  ctx.http.route('POST', '/api/voice/preview', async (_req, body) => {
    const c = cfg();
    const mode = String(body?.mode || 'speak');
    const engine = String(body?.engine || c.engine || 'deepseek');
    const raw = body?.text ?? '';

    if (mode !== 'speak' && mode !== 'lyric') {
      return { ok: false, error: `mode 只支持 speak / lyric，收到 "${mode}"` };
    }

    // 🔀 两种入参（v1.9.2）：
    //   唱歌 → { singer, song } 对象，歌名必填、歌手可空（后端填「原唱」）
    //   朗读 → 字符串
    // 老客户端仍可能传单行字符串给唱歌（"张芸京 偏爱"），保持兼容。
    let text;
    let song;
    if (mode === 'lyric') {
      if (raw && typeof raw === 'object') {
        song = String(raw.song ?? '').trim();
        if (!song) return { ok: false, error: '唱歌模式要先填歌名（歌手可留空）' };
        text = { singer: String(raw.singer ?? '').trim(), song };
      } else {
        text = String(raw || '').trim();
        song = text;
        if (!text) return { ok: false, error: '唱歌模式要先填歌名（歌手可留空）' };
      }
    } else {
      text = String(raw || '').trim();
      if (!text) return { ok: false, error: '缺少 text（要朗读的内容）' };
    }

    let out = null;
    try {
      out = engine === 'deepseek' ? await synthDs(text, { mode }) : await synth(text);
      const buf = fs.readFileSync(out.file);
      if (!buf.length) throw new Error('合成结果为空文件');
      ctx.log?.(`[voice/preview] ${engine}/${mode} ${buf.length}B voice=${out.voice || '-'}`);
      // __raw 让内核原样回二进制（见 src/app.js 的 pluginRoute 分发）
      return {
        __raw: true,
        buffer: buf,
        contentType: 'audio/mpeg',
        filename: `voice-${mode}-${Date.now()}.mp3`
      };
    } catch (e) {
      ctx.log?.(`[voice/preview] 失败 ${engine}/${mode}: ${e?.message ?? e}`);
      return { ok: false, engine, mode, error: String(e?.message ?? e) };
    } finally {
      // 无论成败都清临时文件 —— 试听台不是归档，用户要留就点下载
      if (out?.file) { try { fs.unlinkSync(out.file); } catch { /* ignore */ } }
    }
  }, { absolute: true });


  ctx.http.route('POST', '/api/voice/test', async (_req, body) => {
    const c = cfg();
    const engine = String(body?.engine || c.engine || 'edge');
    try {
      const mode = String(body?.mode || 'speak');
      const r = engine === 'deepseek'
        ? await synthDs(String(body?.text || '这是一条测试语音。'), { mode })
        : await synth(String(body?.text || '这是一条测试语音。'));
      try { fs.unlinkSync(r.file); } catch { /* ignore */ }
      return { ok: true, engine, bytes: r.size, voice: r.voice || null, note: engine === 'deepseek' ? 'DeepSeek 官方音色合成成功（未发送，已在 DS 账号留下本次会话记录）' : '合成成功（未发送）' };
    } catch (e) {
      return { ok: false, engine, error: String(e?.message ?? e) };
    }
  }, { absolute: true });

  return { dispose() {} };
}
