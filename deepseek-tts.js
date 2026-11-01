// ── DeepSeek 官方朗读音色（网页版那个"播放"按钮的声音）─────────────────────
//
// 用户需求（2026-10-21）："deepseek 网页版对话后有一个播放按钮，我想用那个声音"。
//
// ── 那个声音是什么（已核实，不是猜的）──
//   DeepSeek 自研 TTS，四路音色：
//     mira   贝壳（百变活泼）  echo  白浪（明朗坚定）
//     stella 海星（俏皮甜美）  tide  暗潮（低沉浑厚）
//   它不是公开 API，也没有"文本进、音频出"的接口 —— 这是整件事的关键难点。
//
// ── 🔴 朗读 vs 唱歌：两件事，不要混 ──
//   ① **朗读：所有 DS 账号都能用**（🎵 官方的 TTS 对全量开放）。
//      只要账号正常登录，send_voice(mode:"speak") 就能出声。
//   ② **唱歌：只有部分账号能唱出来**。
//      同样是 lyric 文本，有的账号念得抑扬顿挫像在唱，有的账号只会平铺直叙地念 ——
//      这是账号间的实际差异，不是插件能控制的。
//   所以：
//     · 朗读失败 = 有问题（查登录/额度/网络）；
//     · 唱得不像 = 这个号就是这样，换号或接受平读，别当成故障排查。
//   参考：想验证某个号唱得好不好，就发一句带 ♪ 的歌词听一下，效果好就是能唱。
//
// ── 🔴 另一个必须说清的事实：「朗读」≠「唱歌」 ──
//   DS 官方 TTS 协议里 `mode` **只有 "manual" 一个值**（已核实 web-tts.*.js 两处调用点），
//   没有任何 sing / 风格 / 情绪参数。也就是说：
//     · **DS 官方音色只能"朗读"，不能真唱**；
//     · 插件 lyric 模式的"唱"，本质是**让文本带上 ♪ 节奏符号后朗读** —— 是拟态，不是歌声合成；
//     · 主人若要求"真唱/带旋律"，这个能力 DS 不提供，要诚实说明，别假装能唱。
//
//   另外「有朗读资格」和「能唱」是两件事：
//     · 有 🔊 按钮 = 有朗读资格（合成能成功）
//     · 但个别账号的朗读很平/不带节奏感，听起来"唱不出来" —— 那就只能换号或接受朗读效果。
//
// ── 协议（从 fe-static.deepseek.com/chat/static/web-tts.*.js 与 main.js 逆向）──
//   ① POST /api/v0/auth/ticket  {scope:"tts"}       → 一次性 ticket（600s，只用一次）
//   ② GET  /api/v0/chat/tts/voices                  → 音色表（voice_id / name_i18n / demo_urls）
//   ③ POST /api/v0/chat/tts/voice {voice_id}        → 切账号级音色（会改用户账号设置，慎用）
//   ④ wss  /api/v0/chat/tts/?chat_session_id=&message_id=&ticket=&mode=manual&format=pcm
//   请求里**没有正文参数** —— 读哪段文字由服务端从「你自己 DS 会话里的那条消息」取。
//   二进制帧：前 4 字节大端 seq + 负载（pcm = 24kHz 单声道 s16le / opus 裸包）
//   文本帧：  {"event":"ready", audio_id, format, voice_id, trace_id}
//            {"event":"finish", code, msg}
//   客户端：  {"event":"ack", received_seq, played_seq} / {"event":"abort", reason}
//
// ── 因此"任意文字想用这个声音"必须先让文字变成 DS 会话里的一条助手消息 ──
//   投递要调 POST /api/v0/chat/completion，那要 DeepSeekHashV1 的 WASM PoW +
//   Cloudflare cf_clearance + 浏览器 TLS 指纹。**我们一行都不逆向** ——
//   交给本机常驻的真浏览器（CDP :9222）去做，页面自己会算、天然有指纹。
//   合成这一步不需要浏览器：实测 Node 直连 CF 不拦，返回干净的 JSON。
//
// ── 安全 ──
//   DS token 只从浏览器 localStorage 当次读出、只在内存里流转，**不落盘、不进日志、
//   不回显给模型**。登出即失效，无需我们清理。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';

const DS_ORIGIN = 'https://chat.deepseek.com';
const API_BASE = `${DS_ORIGIN}/api/v0`;
const TTS_WS_PATH = '/api/v0/chat/tts/';

/** 伪装成普通网页请求（DS 侧不校验指纹，但带上更像正常客户端） */
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Origin: DS_ORIGIN,
  Referer: `${DS_ORIGIN}/`
};

/** 官方音色（2026-09-12 灰度上线的四路海洋系） */
export const DS_VOICES = [
  { id: 'mira', cn: '贝壳', style: '百变活泼' },
  { id: 'echo', cn: '白浪', style: '明朗坚定' },
  { id: 'stella', cn: '海星', style: '俏皮甜美' },
  { id: 'tide', cn: '暗潮', style: '低沉浑厚' }
];

/**
 * DS 业务码 → 人话。
 * 0=成功 6=无正文（用户消息读不了）4=额度 5=限频 9=账号未放开 12=内容过滤
 */
const CODE_TEXT = {
  0: '成功',
  1: 'DS 朗读服务内部错误',
  2: '请求参数不被朗读服务接受',
  3: '朗读服务暂时不可用',
  4: '今日朗读额度已用完',
  5: '朗读请求过于频繁',
  6: '这条消息没有可朗读的正文（DS 只允许朗读助手消息）',
  7: '当前语言暂不支持朗读',
  8: '该音色不支持当前语言',
  9: 'DS 拒绝了这个账号的朗读请求（可能是账号状态/额度/风控问题，不是灰度限制 —— 朗读本身对所有账号开放）',
  10: '续传票据已过期',
  11: '服务端拒绝了该账号的朗读请求',
  12: '内容未通过服务端过滤'
};

const err = (code, msg, detail = '') => ({ ok: false, code, error: msg, detail });

/** 打一个 DS JSON 接口并解开双层信封 {code,msg,data:{biz_code,biz_msg,biz_data}} */
async function dsJson(pathname, { token, method = 'GET', body, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${pathname}`, {
      method,
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return err('BAD_RESPONSE', `DS 返回了非 JSON（HTTP ${res.status}）`, text.slice(0, 200));
    }
    if (raw?.code !== undefined && raw.code !== 0) {
      if (raw.code === 40003) return err('NOT_LOGGED_IN', 'DS 登录态无效或已过期，请先在浏览器里登录 chat.deepseek.com', raw.msg);
      return err('DS_ERROR', raw.msg || `DS 返回 code=${raw.code}`, JSON.stringify(raw).slice(0, 200));
    }
    const biz = raw?.data;
    if (biz && typeof biz === 'object' && biz.biz_code !== undefined && biz.biz_code !== 0) {
      return err('DS_BIZ', CODE_TEXT[biz.biz_code] || `DS biz_code=${biz.biz_code}`, biz.biz_msg || '');
    }
    return { ok: true, data: biz?.biz_data ?? biz };
  } catch (e) {
    if (ctrl.signal.aborted) return err('TIMEOUT', `调用 DS 接口超时（${timeoutMs}ms）`, pathname);
    return err('NETWORK', `调用 DS 接口失败：${e?.message ?? e}`, pathname);
  } finally {
    clearTimeout(timer);
  }
}

/** 取一张 TTS 票据（一次性，600s 内也只能用一次 —— 每次合成都必须重新取） */
export async function issueTicket(token) {
  const r = await dsJson('/auth/ticket', { token, method: 'POST', body: { scope: 'tts' } });
  if (!r.ok) return r;
  const ticket = typeof r.data?.ticket === 'string' ? r.data.ticket : '';
  if (!ticket) return err('TICKET_FAILED', 'DS 没有返回票据', JSON.stringify(r.data).slice(0, 200));
  return { ok: true, ticket, expiresInSecs: Number(r.data?.expires_in_secs) || 600 };
}

/** 取官方音色表（含 demo_urls，可用于试听对应音色） */
export async function fetchVoices(token) {
  const r = await dsJson('/chat/tts/voices', { token });
  if (!r.ok) return r;
  const list = Array.isArray(r.data?.voices) ? r.data.voices : [];
  return {
    ok: true,
    current: r.data?.current_voice_id || r.data?.default_voice_id || '',
    voices: list.map((v) => ({
      id: v.voice_id,
      name: v.name_i18n?.zh || v.name_i18n?.en || v.voice_id,
      desc: v.description_i18n?.zh || '',
      gender: v.gender,
      demo: Array.isArray(v.demo_urls) ? v.demo_urls[0] : ''
    }))
  };
}

/**
 * 从一条 DS 会话消息合成音频。
 *
 * 票据一次性：本函数内部每次调用都重新取票，绝不复用。
 * @returns {{ok:true, bytes:Buffer, format:string, voiceId:string, audioId:string, frames:number}}
 */
export function synthFromMessage({ token, chatSessionId, messageId, format = 'pcm', timeoutMs = 120000 }) {
  return issueTicket(token).then((t) => {
    if (!t.ok) return t;
    const q = new URLSearchParams({
      chat_session_id: String(chatSessionId || ''),
      message_id: String(messageId || ''),
      ticket: t.ticket,
      mode: 'manual',
      format
    });
    const wsUrl = `wss://chat.deepseek.com${TTS_WS_PATH}?${q.toString()}`;

    return new Promise((resolve) => {
      const frames = new Map();
      let settled = false;
      let sawFinish = false;
      let finishCode;
      let finishMsg = '';
      let serverFormat = format;
      let voiceId = '';
      let audioId = '';
      let lastError = '';

      const ws = new WebSocket(wsUrl, {
        headers: BROWSER_HEADERS,
        perMessageDeflate: false,
        maxPayload: 64 * 1024 * 1024
      });

      const finish = (out) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.terminate(); } catch { /* ignore */ }
        resolve(out);
      };

      const settle = (where) => {
        if (settled) return;
        if (frames.size > 0) {
          if (finishCode !== undefined && finishCode !== 0) {
            finish(err('SYNTH_FAILED', CODE_TEXT[finishCode] || `朗读失败 code=${finishCode}`, `${where} ${finishMsg}`));
            return;
          }
          const seqs = [...frames.keys()].sort((a, b) => a - b);
          const parts = seqs.map((s) => frames.get(s));
          const bytes = Buffer.concat(parts);
          finish({ ok: true, bytes, format: serverFormat, voiceId, audioId, frames: frames.size });
          return;
        }
        if (finishCode !== undefined && finishCode !== 0) {
          finish(err('SYNTH_FAILED', CODE_TEXT[finishCode] || `朗读失败 code=${finishCode}`, `${where} ${finishMsg}`, ));
          return;
        }
        finish(err('SYNTH_FAILED', lastError || 'DS 朗读没有返回音频数据', `${where} frames=0`));
      };

      const timer = setTimeout(() => settle('超时'), timeoutMs);

      // 握手被拒不是 101，而是 HTTP 200 + JSON，必须从这里拿 body 才能给出人话
      ws.on('unexpected-response', (_req, res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let code;
          let msg = '';
          try {
            const j = JSON.parse(body);
            code = j.code;
            msg = j.msg || '';
          } catch { /* 非 JSON：用 HTTP 状态说明 */ }
          finish(err('WS_REJECTED', `朗读握手被拒（HTTP ${res.statusCode}）`, `${msg} ${body.slice(0, 160)}`.trim()));
        });
        res.on('error', () => finish(err('WS_REJECTED', '朗读握手被拒且读取响应失败', `HTTP ${res.statusCode}`)));
      });

      ws.on('message', (data, isBinary) => {
        if (settled) return;
        if (!isBinary) {
          let ctl;
          try {
            ctl = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
          } catch {
            return;
          }
          if (ctl.event === 'ready') {
            if (typeof ctl.format === 'string' && ctl.format) serverFormat = ctl.format;
            if (typeof ctl.voice_id === 'string') voiceId = ctl.voice_id;
            if (typeof ctl.audio_id === 'string') audioId = ctl.audio_id;
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'ack', received_seq: 0, played_seq: 0 }));
            return;
          }
          if (ctl.event === 'finish') {
            sawFinish = true;
            finishCode = typeof ctl.code === 'number' ? ctl.code : 0;
            finishMsg = ctl.msg || '';
            settle('服务端 finish');
            return;
          }
          return;
        }
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length < 5) return;
        const seq = buf.readUInt32BE(0);
        if (!frames.has(seq)) frames.set(seq, buf.subarray(4));
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'ack', received_seq: seq, played_seq: seq }));
      });

      ws.on('error', (e) => {
        lastError = `WS 错误：${e.message}`;
      });

      ws.on('close', (code, reason) => {
        if (settled) return;
        const detail = `WS 关闭 code=${code} ${String(reason || '').slice(0, 100)}`;
        if (!lastError) lastError = detail;
        settle(detail);
      });
    });
  });
}

/** pcm(24k mono s16le) → wav，供 ffmpeg / QQ 直接用 */
export function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitDepth = 16) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitDepth / 8);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * (bitDepth / 8), 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
