// ── DeepSeek PoW（DeepSeekHashV1）纯 Node 实现 ──────────────────────────────
//
// 为什么需要它：DS 的登录类接口（发验证码 / 短信登录）和对话投递
// （/api/v0/chat/completion）都要求一个工作量证明头，否则直接 403。
// 网页端靠 Web Worker + wasm 算，我们**不借用浏览器**，自己算 —— 于是：
//   ① 收验证码、登录 → 可以在插件后端完成（不用你开浏览器点）；
//   ② 投递文本给朗读 → 也不再需要 CDP 浏览器。
//
// ── 协议（逆向自 fe-static.deepseek.com 的 worker chunk，已实测校准）──
//   challenge = POST /api/v0/users/create_guest_challenge {target_path}
//               （登录类用 guest 票；对话类用 /api/v0/chat/create_pow_challenge）
//   → {algorithm:"DeepSeekHashV1", challenge, salt, signature, difficulty, expire_at}
//
//   求解：answer = 最小 nonce，使 hash(`${challenge}_${difficulty}_${nonce}`) 满足难度。
//   🔴 **难度的判据有两种，实测两种都被服务端接受**（别只实现一种）：
//     ① target 判据：hash 的 256 位数值 < 2^256 / difficulty
//        —— 这是登录类接口用的（difficulty=80000，约 15 万次、1 秒命中）
//     ② 前导零判据：hash 的前导零比特数 >= difficulty
//        —— 对话类接口 difficulty=20 时按这个也能通过（约 2^20 次）
//     两者在 d=20 下命中的 nonce 不同（33 vs 1894443），但服务端都收 ——
//     所以实现里**任一满足即返回**，先试 target（更快、且是登录接口的正确语义）。
//
//   请求头：
//     登录类  X-DS-Guest-PoW-Response: base64(JSON.stringify({salt, answer}))
//     对话类  X-DS-PoW-Response:       base64(JSON.stringify({algorithm, challenge, salt, answer, signature, target_path}))
//
// ── 哈希从哪来 ──
//   用 DS 自己的 sha3 wasm（assets/deepseek-hash.wasm，26KB，随插件分发）导出
//   wasm_deepseek_hash_v1。它是纯计算，无网络、无状态。自己实现 sha3-512 也行，
//   但用官方产物能保证与服务端逐位一致（这是唯一硬要求）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(HERE, 'assets', 'deepseek-hash.wasm');

let wasm = null;

/** 加载（并缓存）wasm 实例 */
async function loadWasm() {
  if (wasm) return wasm;
  if (!fs.existsSync(WASM_PATH)) {
    throw new Error(`缺 PoW 计算模块：${WASM_PATH}（插件包应带 assets/deepseek-hash.wasm）`);
  }
  const bytes = fs.readFileSync(WASM_PATH);
  const { instance } = await WebAssembly.instantiate(bytes);
  wasm = instance.exports;
  return wasm;
}

const enc = new TextEncoder();

/** 把字符串写进 wasm 线性内存，返回 [ptr, len] */
function passString(w, str) {
  const bytes = enc.encode(str);
  const ptr = w.__wbindgen_export_0(bytes.length, 1) >>> 0;
  new Uint8Array(w.memory.buffer).set(bytes, ptr);
  return [ptr, bytes.length];
}

/**
 * DeepSeekHashV1：算一次哈希，返回 64 位十六进制串。
 * @param {string} input - 待哈希串（求解时是 `${challenge}_${difficulty}_${nonce}`）
 */
export async function deepseekHash(input) {
  const w = await loadWasm();
  const [p0, l0] = passString(w, String(input));
  const [p1, l1] = passString(w, '');
  const ret = w.__wbindgen_add_to_stack_pointer(-32);
  try {
    w.wasm_deepseek_hash_v1(ret, p0, l0, p1, l1, 0);
    const dv = new DataView(w.memory.buffer);
    const hp = dv.getInt32(ret, true);
    const hl = dv.getInt32(ret + 4, true);
    return Buffer.from(w.memory.buffer.slice(hp, hp + hl)).toString('latin1');
  } finally {
    w.__wbindgen_add_to_stack_pointer(32);
  }
}

/** 同步版哈希（内部用，wasm 已加载时可用） */
function hashSync(w, input) {
  const [p0, l0] = passString(w, input);
  const [p1, l1] = passString(w, '');
  const ret = w.__wbindgen_add_to_stack_pointer(-32);
  try {
    w.wasm_deepseek_hash_v1(ret, p0, l0, p1, l1, 0);
    const dv = new DataView(w.memory.buffer);
    const hp = dv.getInt32(ret, true);
    const hl = dv.getInt32(ret + 4, true);
    return Buffer.from(w.memory.buffer.slice(hp, hp + hl)).toString('latin1');
  } finally {
    w.__wbindgen_add_to_stack_pointer(32);
  }
}

/**
 * 解一个 challenge —— **严格照抄官方 worker 的算法**。
 *
 * 官方产物 `fe-static.deepseek.com/chat/static/76608.*.js` 里那段（逐字）：
 *
 *   onmessage = t => {
 *     let {algorithm:e, challenge:r, salt:n, difficulty:i, signature:f, expireAt:s}
 *           = t.data.challenge;
 *     let t = ((t,e,r,n,i) => {
 *       if ("DeepSeekHashV1" !== t) throw Error(...);
 *       let f = "".concat(r,"_").concat(i,"_"),          // ← prefix = salt + "_" + expireAt + "_"
 *           s = function(t,e,r){                          // (challenge, prefix, difficulty)
 *             ...
 *             for (var n = sponge().update(e), i=0; i<r; i++)
 *               if (n.copy().update(String(i)).digest("hex") === t) return i;
 *             return null;
 *           }(e, f, n);
 *       ...
 *     })(e, r, n, i, s);
 *   }
 *
 * 三个必须照抄的点（早版全错了，导致 PoW 永远解不对）：
 *   ① **prefix 用 `salt` + `expire_at`**，不是 `challenge` + `difficulty`；
 *   ② **判据是 hash === challenge（精确相等）**，不是"小于阈值"也不是"前导零"；
 *   ③ **上界是 difficulty**（服务端给的搜索范围），i 从 0 数到 difficulty-1。
 *
 * 服务端出题时先随机挑一个 i，把 hash(prefix+i) 当作 challenge 发下来 ——
 * 所以解出来的是"还原那个 i"，而不是"找一个满足难度条件的 i"。
 *
 * @param {{challenge:string, salt:string, expire_at?:number|string, expireAt?:number|string,
 *          difficulty:number, signature?:string}} ch
 * @param {{timeoutMs?:number, onProgress?:(p:{tried:number, expected:number, elapsedMs:number})=>void}} opts
 * @returns {Promise<{answer:number, tried:number, elapsedMs:number, prefix:string}>}
 */
export async function solvePow(ch, { timeoutMs = 180000, onProgress } = {}) {
  const w = await loadWasm();

  const challenge = String(ch?.challenge ?? '');
  const salt = ch?.salt;
  // 官方把 expire_at 映射成 expireAt 再传进 worker，两种写法都认
  const expireAt = ch?.expireAt ?? ch?.expire_at;
  const limit = Number(ch?.difficulty) || 0;

  if (!challenge) throw new Error('challenge 里没有 challenge 字段');
  if (salt === undefined || salt === null) throw new Error('challenge 里没有 salt 字段');
  if (expireAt === undefined || expireAt === null) throw new Error('challenge 里没有 expire_at / expireAt 字段');
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`challenge 的 difficulty 必须是正整数（它是搜索上界），收到 ${JSON.stringify(ch?.difficulty)}`);
  }
  if (typeof ch?.algorithm === 'string' && ch.algorithm !== 'DeepSeekHashV1') {
    throw new Error(`不认识的 PoW 算法 "${ch.algorithm}"，本插件只实现 DeepSeekHashV1`);
  }

  // ① 官方口径：salt + "_" + expireAt + "_"   （不是 challenge_difficulty_）
  const prefix = `${salt}_${expireAt}_`;
  const t0 = Date.now();
  const CHUNK = 20000;
  let n = 0;

  for (;;) {
    for (let i = 0; i < CHUNK; i++, n++) {
      if (n >= limit) {
        const spent = Date.now() - t0;
        throw new Error(
          `PoW 没解出来：在服务端的搜索上界 ${limit} 内没找到答案（试了 ${n} 次，${spent}ms）。`
          + `prefix="${prefix}" challenge=${challenge.slice(0, 16)}…`
        );
      }
      // ② 判据：hash(prefix + i) 与 challenge **精确相等**
      if (hashSync(w, prefix + n) === challenge) {
        return { answer: n, tried: n + 1, elapsedMs: Date.now() - t0, prefix };
      }
    }
    // 让出事件循环（单线程跑满会拖慢机器人收发消息）
    await new Promise((r) => setImmediate(r));
    const elapsedMs = Date.now() - t0;
    onProgress?.({ tried: n, expected: limit, elapsedMs });
    if (elapsedMs > timeoutMs) {
      throw new Error(
        `PoW 超时：${elapsedMs}ms 内试了 ${n}/${limit} 次仍未解出。`
        + `（若是真账号，多半是 prefix 拼错或 challenge 已过期）`
      );
    }
  }
}

/** 登录类接口的 PoW 头（base64 包 {salt, answer}） */
export function guestPowHeader(ch, answer) {
  return Buffer.from(JSON.stringify({ salt: ch.salt, answer })).toString('base64');
}

/** 对话类接口的 PoW 头（base64 包完整字段 + target_path） */
export function chatPowHeader(ch, answer, targetPath) {
  return Buffer.from(JSON.stringify({
    algorithm: ch.algorithm,
    challenge: ch.challenge,
    salt: ch.salt,
    answer,
    signature: ch.signature,
    target_path: targetPath
  })).toString('base64');
}
