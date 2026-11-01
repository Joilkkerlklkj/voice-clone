// ── DS 会话投递（纯 Node + PoW，不再依赖浏览器）────────────────────────────
//
// 背景：DS 朗读接口只认 message_id，不接受正文 —— 所以"任意文字想用官方音色"
// 必须先把文字变成 DS 会话里的一条助手消息。
//
// 早期版本靠 CDP 驱动真浏览器投递（让页面自己算 PoW）。现在 PoW 已在插件内
// 纯 Node 实现（pow.js，实测 difficulty=20 四秒解出、服务端认账），
// 于是投递也可以自己做 —— **整个链路一个浏览器都不需要**。
//
// 投递协议（逆向 + 实测）：
//   POST /api/v0/chat/create_pow_challenge {target_path:"/api/v0/chat/completion"}
//     → challenge（同样 DeepSeekHashV1）
//   POST /api/v0/chat/completion  SSE 流式
//     headers: Authorization: Bearer <token>
//              X-DS-PoW-Response: base64({algorithm,challenge,salt,answer,signature,target_path})
//     body:    {chat_session_id, prompt, ref_file_ids:[], thinking_enabled:false, search_enabled:false}
//     → SSE: data:{...biz_data:{chat_session_id, message_id, v}} ... 最后 data:[DONE]
//
//   只接受**助手消息**（用户消息读出来是 code 6/no_content），所以投递词是
//   "请原样输出下面这段文字…"，让它复述一遍，再朗读那条助手回复。
import { solvePow, chatPowHeader } from './pow.js';

const DS = 'https://chat.deepseek.com';
const API = `${DS}/api/v0`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Origin: DS,
  Referer: `${DS}/`,
  'Accept-Language': 'zh-CN,zh;q=0.9'
};

/**
 * 从一条 SSE data 里取出文本增量。
 *
 * 🔴 v1.9.1 修正：真实 SSE 结构与老代码的假设完全不同（2026-10-22 用真账号抓包实测）。
 *
 * 实测三种形状（同一个流里混合出现）：
 *
 *   ① 首帧（带已有内容）
 *      {"v":{"response":{"message_id":2,"role":"ASSISTANT","status":"WIP",
 *            "fragments":[{"id":2,"type":"RESPONSE","content":"床"}]}}}
 *
 *   ② 具名增量
 *      {"p":"response/fragments/-1/content","o":"APPEND","v":"前"}
 *
 *   ③ 裸增量（最常见，长回复里占绝大多数）
 *      {"v":"明月"}
 *      {"v":{"s":"…"}}       ← 搜索/思考分片也可能这样
 *
 * 老代码只认 `obj.data.biz_data` / `obj.biz_data`（那是**非流式**接口的形状），
 * 所以真账号下 answer 永远为空，报「DS 回复为空，没有可朗读的正文」——
 * 即用户看到的那个错误。现在按实测形状解析。
 *
 * 要排除的干扰项（它们也有 `v` 或 `content` 键，但不是正文）：
 *   {"updated_at":...}                                  会话时间戳
 *   {"content":"标题"}                                   自动生成的会话标题（event: title）
 *   {"p":"response","o":"BATCH","v":[...]}               状态批次
 *   {"request_message_id":1,"response_message_id":2,...}  ready 帧
 *
 * @param {any} obj 已解析的 data JSON
 * @returns {string} 文本增量（没有则空串）
 */
export function extractSseText(obj) {
  if (!obj || typeof obj !== 'object') return '';

  // ① 首帧 / 全量快照：v.response.fragments[].content
  const resp = obj?.v?.response;
  if (resp && typeof resp === 'object') {
    const frags = resp.fragments;
    if (Array.isArray(frags)) {
      return frags
        .map((f) => (f && typeof f.content === 'string' ? f.content : ''))
        .join('');
    }
    return '';
  }

  // ② 具名增量：p 指向 fragments 的 content，o=APPEND
  if (typeof obj.p === 'string' && obj.p.includes('fragments') && obj.p.endsWith('content')) {
    return typeof obj.v === 'string' ? obj.v : '';
  }

  // ③ 裸增量：{"v":"明月"} —— 但必须排除 BATCH 状态（v 是数组）与对象形态
  if (typeof obj.v === 'string' && Object.keys(obj).length === 1) {
    return obj.v;
  }

  // ④ 极少数情况：{"v":{"content":"..."}} 或 {"v":{"s":"..."}}
  if (obj.v && typeof obj.v === 'object' && !Array.isArray(obj.v)) {
    if (typeof obj.v.content === 'string') return obj.v.content;
  }

  // 其余（updated_at / title / close / ready / BATCH）都不是正文
  return '';
}

/**
 * 组装最终发给 /chat/completion 的 prompt。
 *
 * 两种语义（别混）：
 *   · promptIsFinal=true  —— 已经是完整指令，原样发。唱歌模板走这条：
 *       直接输出，XXX的《YYY》，不要输出除了歌词以外的内容，包括思考内容，
 *       制作信息，歌词标题。最后在歌词的最前面加一句"预备，唱！"
 *     —— 这条要模型**执行**（去生成歌词），不是要它复述这段话本身。
 *   · promptIsFinal=false —— 普通朗读：包一层"原样输出"壳，让它老实复述，
 *     不添加"好的，这句话是…"之类的客套。
 *
 * @param {string} text
 * @param {boolean} promptIsFinal
 * @returns {string}
 */
export function buildPrompt(text, promptIsFinal = false) {
  const body = String(text ?? '');
  if (promptIsFinal) return body;
  return `请原样输出下面这段文字，不要添加任何解释、不要改动标点或格式：\n\n${body}`;
}

/**
 * 投递一段文字，拿回助手消息的 message_id。
 *
 * 🔴 v1.8 关键修正：`promptIsFinal` 选项（用户 2026-10-22 指出）
 *
 *   早版**无条件**把传进来的东西包一层「请原样输出下面这段文字…」，
 *   于是唱歌模板 `直接输出，XX的《YY》，不要输出除了歌词以外的内容…预备，唱！`
 *   变成了「请原样输出：直接输出，XX的《YY》，不要输出除了歌词以外的内容…」——
 *   模型会**照抄这句指令**当成要复述的文字，唱出来的是提示词本身，不是歌词。
 *
 *   现在分两种：
 *     · promptIsFinal: true  → 传进来的已经是完整指令，**原样发出**（唱歌模式用这个）
 *     · 默认                 → 包「请原样输出」壳（普通朗读用这个）
 *
 *   为什么普通朗读还要包壳：DS 的 TTS 只念助手消息，而直接发「你好」模型会
 *   加"你好！有什么可以帮你的吗？"之类的客套 —— 包壳能让它老实复述原句。
 *   唱歌模板本身就是一条完整指令，模型会去执行（生成歌词），不能再套壳。
 *
 * @param {string} token - DS userToken
 * @param {string} text - 待复述的文字，或（promptIsFinal 时）完整指令
 * @param {{chatSessionId?:string, timeoutMs?:number, promptIsFinal?:boolean}} opts
 * @returns {Promise<{ok:boolean, chatSessionId?:string, assistantMsgId?:string, text?:string, error?:string}>}
 */
export async function deliverText(token, text, { chatSessionId = '', timeoutMs = 120000, promptIsFinal = false, mode = 'speak' } = {}) {
  const targetPath = '/api/v0/chat/completion';

  // 没有会话就先建一个 —— chat_session_id 必须是 UUID，传空串会被 422 拒绝
  if (!chatSessionId) {
    const created = await createSession(token);
    if (!created.ok) return { ok: false, error: `创建会话失败：${created.error}` };
    chatSessionId = created.id;
  }

  // ① 取 challenge 并求解
  let challenge;
  try {
    const r = await fetch(`${API}/chat/create_pow_challenge`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ target_path: targetPath }),
      signal: AbortSignal.timeout(20000)
    });
    const j = await r.json();
    if (j?.code !== 0) {
      if (j?.code === 40003 || j?.code === 40002) return { ok: false, error: 'DS 登录态无效或已过期' };
      return { ok: false, error: `取 PoW challenge 失败：${j?.msg || j?.code}` };
    }
    challenge = j.data.biz_data.challenge;
    if (!challenge) return { ok: false, error: 'DS 没有返回 challenge' };
  } catch (e) {
    return { ok: false, error: `取 challenge 请求失败：${e?.message ?? e}` };
  }

  const solved = await solvePow(challenge, { timeoutMs: 180000 });
  const powHeader = chatPowHeader(challenge, solved.answer, targetPath);

  // ② 投递（SSE 流式读）
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/chat/completion`, {
      method: 'POST',
      headers: {
        ...HEADERS,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-DS-PoW-Response': powHeader,
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        chat_session_id: String(chatSessionId || ''),
        prompt: buildPrompt(text, promptIsFinal),
        ref_file_ids: [],
        thinking_enabled: false,
        search_enabled: false
      }),
      signal: ctrl.signal
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `投递被拒（HTTP ${res.status}）`, detail: body.slice(0, 300) };
    }

    // 逐行解析 SSE
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let sessionId = String(chatSessionId || '');
    let answer = '';
    const ids = [];
    let bizError = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        if (obj?.code !== undefined && obj.code !== 0) { bizError = obj.msg || `code ${obj.code}`; continue; }
        const got = extractSseText(obj);
        if (got) {
          answer += got;
          if (obj?.v?.response?.message_id != null) ids.push(String(obj.v.response.message_id));
        }
        if (obj?.request_message_id != null || obj?.response_message_id != null) continue;
      }
    }

    if (bizError) return { ok: false, error: `DS 拒绝投递：${bizError}` };
    if (!answer.trim()) return { ok: false, error: 'DS 回复为空，没有可朗读的正文' };

    // ③ 唱歌模式的内容校验（v1.8）
    //    模型偶尔会"只复述指令"或"只回一句预备，唱！"就收工 —— 那样合成出来是废话。
    //    判据（三关全过才算真唱）：
    //      a) 必须以「预备，唱！」开头
    //      b) 去掉这句后至少 8 字
    //      c) **不能是把指令本身复述回来**（含"直接输出，"或"不要输出除了歌词"这类指令特征）
    if (mode === 'lyric') {
      if (!/^\s*预备[，,]?\s*唱[！!]?/.test(answer)) {
        return {
          ok: false,
          error: `模型输出开头不是"预备，唱！"（实际：${JSON.stringify(answer.slice(0, 40))}）`
        };
      }
      const lyricOnly = answer.replace(/^\s*预备[，,]?\s*唱[！!]?\s*/, '').trim();
      if (lyricOnly.length < 8) {
        return {
          ok: false,
          error: `模型没生成歌词（去掉"预备，唱！"后只剩 ${lyricOnly.length} 字：${JSON.stringify(lyricOnly.slice(0, 40))}）`
        };
      }
      // 复述检测：模型把指令当歌词抄了回来
      if (/直接输出|不要输出除了歌词|制作信息|歌词标题/.test(lyricOnly)) {
        return {
          ok: false,
          error: `模型复述了指令而不是唱歌词（${JSON.stringify(lyricOnly.slice(0, 50))}）`
        };
      }
    }

    // ③ 拿 message_id：优先从 SSE 里出现过的 id 反查历史，确认是助手消息
    let assistantMsgId = '';
    const hist = await readHistory(token, sessionId);
    if (hist.ok) {
      if (ids.length) {
        const hit = hist.rows.filter((m) => m.role === 'assistant' && ids.includes(m.id)).pop();
        if (hit) assistantMsgId = hit.id;
      }
      if (!assistantMsgId) {
        const last = hist.rows.filter((m) => m.role === 'assistant').pop();
        if (last) assistantMsgId = last.id;
      }
    }
    if (!assistantMsgId && ids.length) assistantMsgId = ids[ids.length - 1];
    if (!assistantMsgId) return { ok: false, error: '投递成功但拿不到 message_id' };

    return { ok: true, chatSessionId: sessionId, assistantMsgId, text: answer };
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, error: `投递超时（${timeoutMs}ms）` };
    return { ok: false, error: `投递失败：${e?.message ?? e}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 新建一个 DS 会话，返回它的 id。
 *
 * 🔴 为什么需要：`/chat/completion` 的 `chat_session_id` 是 **UUID 格式**，
 * 传空串会 422（实测报错：`UUID parsing failed: invalid length: expected length 32`）。
 * 所以每次投递前若无指定会话，先建一个空的。
 */
export async function createSession(token) {
  try {
    const r = await fetch(`${API}/chat_session/create`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(20000)
    });
    const j = await r.json();
    if (j?.code !== 0) return { ok: false, error: j?.msg || `code=${j?.code}` };
    const id = j?.data?.biz_data?.chat_session?.id || '';
    if (!id) return { ok: false, error: '创建会话没返回 id' };
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** 读会话历史（拿 message_id / 角色 / 正文） */
export async function readHistory(token, chatSessionId) {
  try {
    const r = await fetch(
      `${API}/chat/history_messages?chat_session_id=${encodeURIComponent(String(chatSessionId || ''))}`,
      {
        headers: { ...HEADERS, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20000)
      }
    );
    const j = await r.json();
    if (j?.code !== 0) return { ok: false, error: j?.msg || `code=${j?.code}` };
    const list = j?.data?.biz_data?.chat_messages || [];
    return { ok: true, rows: normalizeRows(list) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** 归一化历史行（字段名无公开文档，宽松取） */
export function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => {
      if (!r || typeof r !== 'object') return null;
      const id = r.message_id ?? r.messageId ?? r.msg_id ?? r.id;
      const rawRole = String(r.role ?? r.role_type ?? r.type ?? '').toUpperCase();
      // 🔴 v1.9.1：真实历史接口的正文在 fragments[].content，不在顶层 content。
      //    实测结构（2026-10-22）：
      //      {"message_id":1,"role":"USER","status":"FINISHED",
      //       "fragments":[{"id":1,"type":"REQUEST","content":"请原样输出…"}]}
      //    老代码只读 r.content → 永远空串 → range 校验和选消息都会错。
      let content = '';
      if (typeof r.content === 'string') {
        content = r.content;
      } else if (Array.isArray(r.content)) {
        content = r.content.map((c) => (typeof c === 'string' ? c : c?.content ?? c?.text ?? '')).join('');
      } else if (Array.isArray(r.fragments)) {
        // 同一消息可能有多个片段（REQUEST / RESPONSE / THINKING…），只拼正文类
        content = r.fragments
          .filter((f) => f && (f.type === 'RESPONSE' || f.type === 'REQUEST' || f.type === undefined))
          .map((f) => (typeof f.content === 'string' ? f.content : ''))
          .join('');
      }
      return {
        id: id === undefined || id === null ? '' : String(id),
        role: rawRole === 'ASSISTANT' ? 'assistant' : rawRole === 'USER' ? 'user' : 'other',
        content,
        status: String(r.status ?? '')
      };
    })
    .filter(Boolean);
}
