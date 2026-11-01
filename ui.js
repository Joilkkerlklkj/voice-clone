// ══════════════════════════════════════════════════════════════
//  voice · 插件配置面板（v1.2：双引擎 + DS 官方账号登录）
// ══════════════════════════════════════════════════════════════
//
// 架构约束（2026-10-21）：插件功能的前端代码必须在本目录，
// 不许写进内核 ui/app.js。内核只通过 mountPanel(box, ctx) 调用这里。

const DS_VOICES_LOCAL = [
  { id: 'mira', cn: '贝壳', style: '百变活泼' },
  { id: 'echo', cn: '白浪', style: '明朗坚定' },
  { id: 'stella', cn: '海星', style: '俏皮甜美' },
  { id: 'tide', cn: '暗潮', style: '低沉浑厚' }
];

const EDGE_VOICES = [
  'zh-CN-XiaoxiaoNeural:女·温暖',
  'zh-CN-XiaoyiNeural:女·活泼',
  'zh-CN-YunxiNeural:男·阳光',
  'zh-CN-YunyangNeural:男·播报',
  'zh-CN-YunjianNeural:男·浑厚',
  'zh-CN-YunxiaNeural:男·少年'
];

const DS_LOGIN_URL = 'https://chat.deepseek.com/sign_in';

export async function mountPanel(box, ctx) {
  const { $, api, bindPanelClose, esc, panelShell, savePluginConfig } = ctx;
  const d = await api('/api/voice/status');
  const c = d.config || {};
  const env = d.env || {};
  const okEnv = env.ffmpeg;

  box.innerHTML = panelShell('voice', '语音（说 / 听）', `
    <div class="row" style="gap:12px;flex-wrap:wrap;font-size:13px;margin-bottom:12px">
      <span>Python：<code>${esc(env.python || '?')}</code></span>
      <span>venv：${env.hasVenv ? '✅ 已有' : '<span class="muted">未建（用系统 python3）</span>'}</span>
      <span>ffmpeg：${okEnv ? '✅' : '<span class="error">❌ 未安装</span>'}</span>
    </div>
    ${!okEnv ? '<p class="error" style="font-size:13px">缺 ffmpeg，语音转码会失败。安装：<code>sudo apt install -y ffmpeg</code></p>' : ''}
    <!-- ═══ 声音模式：两个卡片，点一下即切换 ═══ -->
    <div style="margin:10px 0 14px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">选择声音模式</div>
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <button class="vo-mode ${c.engine === 'deepseek' ? 'on' : ''}" data-engine="deepseek"
          style="flex:1;min-width:230px;text-align:left;padding:11px 13px;border-radius:10px;cursor:pointer;
                 border:2px solid ${c.engine === 'deepseek' ? '#3a6df0' : 'var(--line,#ddd)'};
                 background:${c.engine === 'deepseek' ? 'rgba(58,109,240,.07)' : 'transparent'}">
          <div style="font-size:13.5px;font-weight:600">
            ${c.engine === 'deepseek' ? '✅ ' : ''}DeepSeek 官方音色
          </div>
          <div class="muted" style="font-size:11.5px;line-height:1.5;margin-top:3px">
            网页版那个声音（贝壳/白浪/海星/暗潮）<br>约 10~30 秒 · 耗每日额度
          </div>
        </button>
        <button class="vo-mode ${c.engine !== 'deepseek' ? 'on' : ''}" data-engine="edge"
          style="flex:1;min-width:230px;text-align:left;padding:11px 13px;border-radius:10px;cursor:pointer;
                 border:2px solid ${c.engine !== 'deepseek' ? '#3a6df0' : 'var(--line,#ddd)'};
                 background:${c.engine !== 'deepseek' ? 'rgba(58,109,240,.07)' : 'transparent'}">
          <div style="font-size:13.5px;font-weight:600">
            ${c.engine !== 'deepseek' ? '✅ ' : ''}微软 edge 音色
          </div>
          <div class="muted" style="font-size:11.5px;line-height:1.5;margin-top:3px">
            秒回 · 免费无限 · 音色稳定<br>晓晓/云希/云扬等 6 款
          </div>
        </button>
      </div>
      <div id="vo-mode-out" class="muted" style="font-size:11.5px;margin-top:6px"></div>
    </div>

    <div class="row" style="gap:12px;flex-wrap:wrap">
      <label>edge 音色
        <select id="vo-voice" class="gr-select" style="min-width:200px">
          ${EDGE_VOICES.map((o) => {
            const [v, label] = o.split(':');
            return `<option value="${v}" ${c.ttsVoice === v ? 'selected' : ''}>${label}（${v}）</option>`;
          }).join('')}
        </select>
      </label>
      <label>语速 <input id="vo-rate" value="${esc(c.ttsRate || '+0%')}" style="width:80px" /></label>
      <label>识别模型
        <select id="vo-model" class="gr-select">
          ${['tiny', 'base', 'small', 'medium'].map((m) => `<option value="${m}" ${c.sttModel === m ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
      </label>
    </div>

    <!-- ═══ DeepSeek 官方账号（登录入口 + 状态）═══ -->
    <div style="margin-top:14px;border:1px solid var(--line,#ddd);border-radius:10px;padding:12px 14px">
      <div class="row" style="justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <b>DeepSeek 官方账号</b>
        <a href="${DS_LOGIN_URL}" target="_blank" rel="noopener"
           style="font-size:12.5px;text-decoration:underline">↗ 官方登录页</a>
      </div>
      <div id="vo-ds-status" class="muted" style="font-size:12.5px;margin:8px 0">读取状态中…</div>

      <!-- 能力声明（用户 2026-10-22 要求：只声明，不做判断） -->
      <div style="margin:8px 0;padding:9px 11px;border-radius:7px;font-size:11.5px;line-height:1.7;
                  background:rgba(200,120,0,.07);border:1px solid rgba(200,120,0,.25)">
        <b>⚠️ 关于「朗读」与「唱歌」</b><br>
        · <b>朗读：所有账号都能用</b> —— 登录了就能出声，不限账号。<br>
        · <b>唱歌：只有部分账号能唱出来</b> —— 同样一段带 ♪ 的歌词，
          有的号念得有旋律感，有的号只会平着念。这是<b>账号差异</b>，不是故障。<br>
        · 若这个号唱得不理想，到下面<b>换号</b>试试（多账号切换），或接受平读效果。
      </div>

      <!-- ═══ 账号列表 + 切换 ═══ -->
      <div id="vo-acc-box" style="margin:8px 0 10px"></div>


      <div id="vo-ds-login" style="margin-top:8px">

        <!-- ★ 微信扫码（境内节点可直出二维码）-->
        <div style="border:1px solid var(--line,#e3e3e3);border-radius:8px;padding:10px 12px;margin-bottom:10px;background:rgba(0,120,255,.03)">
          <div style="font-size:13px;font-weight:600;margin-bottom:6px">微信扫码登录</div>
          <div class="muted" style="font-size:12px;line-height:1.75">
            点「生成二维码」→ 服务器用无头浏览器打开 DS 登录页并截出二维码 → 你手机扫码确认
            → 点「我已扫码，读取登录态」即可。<br>
            <span style="font-size:11.5px">⚠️ 二维码由<b>服务器出口 IP</b>决定：境内节点（如阿里云）直接可用；
            美国节点 DS 不提供扫码入口，请改用下面的「贴 token」。</span>
          </div>
          <div class="row" style="gap:8px;margin-top:9px;flex-wrap:wrap">
            <button class="btn primary" id="vo-ds-qr">生成二维码</button>
            <button class="btn" id="vo-ds-qr-finish" disabled>我已扫码，读取登录态</button>
            <button class="btn" id="vo-ds-qr-cancel" style="display:none">放弃</button>
            <button class="btn" id="vo-ds-qr-reset" style="color:#c00">强制解锁</button>
          </div>
          <div id="vo-ds-qr-out" class="muted" style="font-size:12px;margin-top:8px"></div>
          <div id="vo-ds-qr-box" style="display:none;margin-top:10px;text-align:center"></div>
        </div>

        <!-- 贴 token（所有地区通用的兜底方案）-->
        <div style="border:1px solid var(--line,#e3e3e3);border-radius:8px;padding:10px 12px;margin-bottom:10px">
          <div style="font-size:13px;font-weight:600;margin-bottom:6px">贴 token（任意地区可用）</div>
          <div class="muted" style="font-size:12px;line-height:1.75">
            在你电脑浏览器打开 <a href="${DS_LOGIN_URL}" target="_blank" rel="noopener">chat.deepseek.com</a>
            用微信扫码或手机号登录 → <code>F12</code> → Console 执行：
            <div style="margin:6px 0"><code style="display:block;background:rgba(0,0,0,.06);padding:7px 9px;border-radius:5px;font-size:11.5px;word-break:break-all;user-select:all">JSON.parse(localStorage.getItem('userToken')).value</code></div>
            <button class="btn" id="vo-ds-copy" style="font-size:12px;padding:3px 10px">复制这段代码</button>
            <span id="vo-ds-copy-out" class="muted" style="font-size:11.5px"></span>
          </div>
          <div class="row" style="gap:8px;margin-top:9px;flex-wrap:wrap">
            <input id="vo-ds-token2" placeholder="粘贴 userToken" style="flex:1;min-width:240px" />
            <button class="btn primary" id="vo-ds-token2-btn">保存</button>
          </div>
          <div id="vo-ds-token2-out" class="muted" style="font-size:12px;margin-top:6px"></div>
        </div>

        <!-- 短信（受数美风控限制）-->
        <details style="margin-top:6px">
          <summary style="cursor:pointer;font-size:12.5px">短信验证码登录（受 DS 真人风控限制，通常用不了）</summary>
          <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
            <input id="vo-ds-mobile" placeholder="手机号（11 位）" style="width:150px" />
            <button class="btn" id="vo-ds-send">发送验证码</button>
            <input id="vo-ds-code" placeholder="短信验证码" style="width:110px" />
            <button class="btn primary" id="vo-ds-login-btn">登录</button>
          </div>
          <div id="vo-ds-sms-out" class="muted" style="font-size:12px;margin-top:6px"></div>
        </details>

        <details style="margin-top:10px">
          <summary style="cursor:pointer;font-size:12.5px">用 token 直接登录（备用，从浏览器 F12 复制）</summary>
          <div style="margin-top:8px;font-size:12.5px;line-height:1.7">
            ① 点上方「打开官方登录页」，用手机号/微信/Google 登录；<br>
            ② 登录后按 <code>F12</code> → Console，粘贴执行：<br>
            <code style="display:block;background:rgba(0,0,0,.05);padding:6px;border-radius:4px;margin:4px 0">JSON.parse(localStorage.getItem('userToken')).value</code>
            ③ 把输出（一长串字符）贴到下面：
          </div>
          <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">
            <input id="vo-ds-token" placeholder="粘贴 userToken" style="flex:1;min-width:240px" />
            <button class="btn primary" id="vo-ds-token-btn">保存</button>
            <button class="btn" id="vo-ds-import">从本机浏览器导入</button>
          </div>
          <div id="vo-ds-token-out" class="muted" style="font-size:12px;margin-top:6px"></div>
        </details>
      </div>

      <div class="row" style="gap:8px;margin-top:10px">
        <button class="btn" id="vo-ds-logout">退出登录（删除本地凭据）</button>
      </div>
      <div class="muted" style="font-size:11.5px;margin-top:8px;line-height:1.6">
        🔒 token 只存本机 <code>plugins/voice/ds-credentials.json</code>（0600），面板只显示掩码，不回显原文。<br>
        ⚠️ 短信登录的「发送验证码」会先算 PoW（约几秒），但真发码还需过 DS 的数美验证码 ——
        那一步<b>只能真人在官方页面完成</b>，所以推荐用上面的 token 方式。
      </div>
    </div>

    <div class="row" style="gap:12px;flex-wrap:wrap;margin-top:12px">
      <label>DS 音色
        <select id="vo-dsvoice" class="gr-select" style="min-width:200px">
          ${DS_VOICES_LOCAL.map((v) => `<option value="${v.id}" ${c.dsVoice === v.id ? 'selected' : ''}>${v.cn}（${v.id}）· ${v.style}</option>`).join('')}
        </select>
      </label>
      <label>DS 单句字数上限 <input id="vo-dsmax" value="${esc(String(c.dsMaxChars || 200))}" style="width:70px" /></label>
      <label>DS 会话 id（可选）<input id="vo-dssession" value="${esc(c.dsSessionId || '')}" style="width:180px" /></label>
    </div>

    <div class="row" style="gap:16px;margin-top:12px">
      <label class="switch-row"><input type="checkbox" id="vo-auto" ${c.autoTranscribe ? 'checked' : ''} />
        <span>自动转写群友语音</span></label>
    </div>
    <div class="row" style="gap:8px;margin-top:12px">
      <button class="btn primary" id="vo-save">保存</button>
      <span id="vo-test-out" class="muted" style="font-size:12px"></span>
    </div>

    <!-- ─────────── 试音台（v1.9 新增）─────────── -->
    <div style="margin-top:16px;border-top:1px dashed rgba(0,0,0,.12);padding-top:14px">
      <div style="font-weight:600;font-size:13px;margin-bottom:4px">🎤 试音台</div>
      <div class="muted" style="font-size:11.5px;margin-bottom:10px">
        登录后在这里直接听效果，不用发到群里。<b>合成结果不发送、只回放在本页</b>；
        DS 引擎每次会在你的 DS 账号留一条会话记录。
      </div>

      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">
        <label>模式
          <select id="vo-tb-mode" class="gr-select" style="min-width:150px">
            <option value="speak">朗读（普通说话）</option>
            <option value="lyric">唱歌（歌词）</option>
          </select>
        </label>
        <label>引擎
          <select id="vo-tb-engine" class="gr-select" style="min-width:170px">
            <option value="deepseek">DeepSeek 官方音色</option>
            <option value="edge">edge（微软）</option>
          </select>
        </label>
      </div>

      <!-- 输入区：按模式切换（唱歌=歌手+歌名两个字段；朗读=多行文本） -->
      <div id="vo-tb-speak-box" style="margin-top:10px;display:none">
        <textarea id="vo-tb-text" rows="3" placeholder="朗读：输入要念的文字，如 今天辛苦了，早点睡。"
                  style="width:100%;box-sizing:border-box;resize:vertical;font-family:inherit"></textarea>
      </div>

      <div id="vo-tb-lyric-box" style="margin-top:10px">
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
          <label style="flex:1;min-width:150px">歌手
            <input id="vo-tb-singer" placeholder="如 张芸京（留空则为「原唱」）"
                   style="width:100%;box-sizing:border-box" />
          </label>
          <label style="flex:1.4;min-width:180px">歌名
            <input id="vo-tb-song" placeholder="如 偏爱 / 离离原上草"
                   style="width:100%;box-sizing:border-box" />
          </label>
        </div>
        <div class="muted" style="font-size:11px;margin-top:5px">
          只填这两个就够，歌词由模型自己生成 —— 不用自己贴歌词。
        </div>
      </div>

      <div id="vo-tb-hint" class="muted" style="font-size:11.5px;margin-top:8px"></div>

      <div class="row" style="gap:8px;margin-top:10px;align-items:center">
        <button class="btn primary" id="vo-tb-go">合成并试听</button>
        <button class="btn" id="vo-tb-stop" disabled>停止</button>
        <span id="vo-tb-out" class="muted" style="font-size:12px"></span>
      </div>

      <div id="vo-tb-player" style="display:none;margin-top:10px">
        <audio id="vo-tb-audio" controls style="width:100%;height:36px"></audio>
        <div class="row" style="gap:8px;margin-top:6px">
          <a id="vo-tb-dl" class="btn" style="font-size:12px;padding:2px 10px;text-decoration:none" download>下载音频</a>
          <span id="vo-tb-meta" class="muted" style="font-size:11.5px"></span>
        </div>
      </div>

      <details style="margin-top:10px">
        <summary style="cursor:pointer;font-size:12px;color:#666">查看实际发给模型的提示词</summary>
        <pre id="vo-tb-prompt" class="muted"
             style="font-size:11px;white-space:pre-wrap;word-break:break-all;margin:6px 0 0;max-height:150px;overflow:auto"></pre>
      </details>
    </div>

    <p class="muted" style="font-size:12px;margin-top:10px">
      依赖不随插件包分发。安装：<br>
      <code>python3 -m venv plugins/voice/.venv &amp;&amp; plugins/voice/.venv/bin/pip install edge-tts faster-whisper "av&lt;13"</code></p>`,
    '说：文字→语音（NapCat 自动转 silk）；听：语音→文字（本地 whisper，不出机器）');

  bindPanelClose(box);

  // ── 账号列表（多账号切换）──
  const refreshAccounts = async () => {
    const boxEl = $('#vo-acc-box');
    if (!boxEl) return;
    try {
      const r = await api('/api/voice/ds/accounts');
      const accs = r.accounts || [];
      if (accs.length <= 0) { boxEl.innerHTML = ''; return; }
      boxEl.innerHTML = `
        <div style="font-size:12.5px;font-weight:600;margin-bottom:6px">
          已保存账号（${accs.length}）· 点「切换」换号
        </div>
        ${accs.map((a) => `
          <div class="row" data-acc="${esc(a.id)}"
               style="gap:8px;align-items:center;padding:7px 9px;margin-bottom:5px;border-radius:7px;
                      border:1px solid ${a.isActive ? '#3a6df0' : 'var(--line,#e5e5e5)'};
                      background:${a.isActive ? 'rgba(58,109,240,.06)' : 'transparent'};flex-wrap:wrap">
            <span style="font-size:12.5px;min-width:130px">
              ${a.isActive ? '✅ ' : ''}<b>${esc(a.label || a.id)}</b>
            </span>
            <code style="font-size:11px;opacity:.65">${esc(a.tokenMask)}</code>
            <span class="muted" style="font-size:11px">${esc(a.source || '')}</span>
            ${a.isActive
              ? '<span style="font-size:11px;color:#3a6df0">使用中</span>'
              : `<button class="btn vo-acc-switch" data-id="${esc(a.id)}" style="font-size:11.5px;padding:2px 9px">切换</button>`}
            <button class="btn vo-acc-del" data-id="${esc(a.id)}"
                    style="font-size:11.5px;padding:2px 9px;color:#c00">删除</button>
          </div>
        `).join('')}
        <div id="vo-acc-out" class="muted" style="font-size:11.5px;margin-top:4px"></div>`;

      boxEl.querySelectorAll('.vo-acc-switch').forEach((b) => {
        b.addEventListener('click', async () => {
          const id = b.dataset.id;
          const o = $('#vo-acc-out');
          if (o) o.textContent = '切换中（含 token 注入浏览器）…';
          try {
            const res = await api('/api/voice/ds/switch', { method: 'POST', body: JSON.stringify({ accountId: id }) });
            if (res.ok) {
              if (o) o.textContent = `✅ 已切到「${res.account.label}」${res.injected ? '，浏览器登录态已同步' : ''}`;
              await refreshAccounts();
              refreshDs();
            } else if (o) o.textContent = '❌ ' + res.error;
          } catch (e) { if (o) o.textContent = '❌ ' + e.message; }
        });
      });

      boxEl.querySelectorAll('.vo-acc-del').forEach((b) => {
        b.addEventListener('click', async () => {
          const id = b.dataset.id;
          if (!confirm('确定删除这个账号的凭据？')) return;
          try {
            const res = await api('/api/voice/ds/remove', { method: 'POST', body: JSON.stringify({ accountId: id }) });
            if (res.ok) { await refreshAccounts(); refreshDs(); }
            else alert(res.error);
          } catch (e) { alert(e.message); }
        });
      });
    } catch (e) {
      boxEl.innerHTML = `<span class="muted" style="font-size:11.5px">账号列表读取失败：${esc(e.message)}</span>`;
    }
  };
  refreshAccounts();

  // ── 声音模式切换（点卡片即存，立刻生效）──
  let currentEngine = c.engine === 'deepseek' ? 'deepseek' : 'edge';
  box.querySelectorAll('.vo-mode').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const eng = btn.dataset.engine;
      if (eng === currentEngine) return;
      out('#vo-mode-out', '切换中…');
      try {
        await savePluginConfig('voice', { engine: eng });
        currentEngine = eng;
        // 重画两个卡片的选中态
        box.querySelectorAll('.vo-mode').forEach((b) => {
          const on = b.dataset.engine === eng;
          b.style.border = `2px solid ${on ? '#3a6df0' : 'var(--line,#ddd)'}`;
          b.style.background = on ? 'rgba(58,109,240,.07)' : 'transparent';
          const t = b.querySelector('div');
          const base = b.dataset.engine === 'deepseek' ? 'DeepSeek 官方音色' : '微软 edge 音色';
          if (t) t.textContent = (on ? '✅ ' : '') + base;
        });
        out('#vo-mode-out', eng === 'deepseek'
          ? '✅ 已切到 DeepSeek 官方音色（下一句语音就用它）'
          : '✅ 已切到微软 edge 音色（秒回）');
      } catch (e) {
        out('#vo-mode-out', '❌ ' + e.message, true);
      }
    });
  });

  // ── DS 状态刷新 ──
  const refreshDs = async () => {
    const el = $('#vo-ds-status');
    if (el) el.textContent = '读取状态中…';
    try {
      const s = await api('/api/voice/ds/status');
      if (!el) return;
      if (!s.saved) {
        el.innerHTML = '<span style="color:#c00">❌ 未登录</span>'
          + (s.browserTokenAvailable ? ' · 检测到本机浏览器已登录，可点下面「从本机浏览器导入」' : '')
          + (s.browserError && !s.browserTokenAvailable ? ` <span class="muted">（${esc(s.browserError)}）</span>` : '');
      } else if (s.valid) {
        const cur = (s.voices || []).find((v) => v.id === s.currentVoice);
        el.innerHTML = '✅ 已登录 · token <code>' + esc(s.tokenMask) + '</code>'
          + (s.source ? ` · 来源 ${esc(s.source)}` : '')
          + (cur ? ` · 账号音色 <b>${esc(cur.name)}</b>` : '')
          + (s.savedAt ? `<br><span class="muted">保存于 ${esc(s.savedAt)}</span>` : '');
      } else {
        el.innerHTML = '<span style="color:#c00">⚠️ 凭据已保存但已失效：' + esc(s.error || '') + '</span>'
          + '<br><span class="muted">token <code>' + esc(s.tokenMask) + '</code>，请重新登录</span>';
      }
    } catch (e) {
      if (el) el.innerHTML = '<span style="color:#c00">状态读取失败：' + esc(e.message) + '</span>';
    }
  };
  refreshDs();

  const out = (id, msg, isErr) => {
    const el = $(id);
    if (el) el.innerHTML = isErr ? `<span style="color:#c00">${esc(msg)}</span>` : esc(msg);
  };

  // ── 生成二维码 ──
  $('#vo-ds-qr')?.addEventListener('click', async () => {
    const o = $('#vo-ds-qr-out');
    const box = $('#vo-ds-qr-box');
    o.textContent = '正在启动无头浏览器渲染二维码（约 10-25 秒）…';
    box.style.display = 'none';
    try {
      const r = await api('/api/voice/ds/qr', { method: 'POST', body: '{}' });
      if (r.ok) {
        box.innerHTML = `<img src="${r.image}" alt="微信扫码" style="width:240px;height:240px;border:1px solid var(--line,#ddd);border-radius:8px" />`;
        box.style.display = 'block';
        o.innerHTML = `✅ 二维码已生成（地区 ${esc(r.region)}）· ${Math.round(r.bytes/1024)}KB`;
        $('#vo-ds-qr-finish').disabled = false;
        $('#vo-ds-qr-cancel').style.display = '';
      } else {
        o.innerHTML = `❌ ${esc(r.error)}` + (r.hint ? `<br><span class="muted">${esc(r.hint)}</span>` : '');
      }
    } catch (e) { o.innerHTML = `<span style="color:#c00">${esc(e.message)}</span>`; }
  });

  // ── 扫码完成，读取登录态 ──
  $('#vo-ds-qr-finish')?.addEventListener('click', async () => {
    const o = $('#vo-ds-qr-out');
    o.textContent = '正在读取登录态…';
    try {
      const r = await api('/api/voice/ds/qr-finish', { method: 'POST', body: '{}' });
      if (r.ok) {
        o.innerHTML = `✅ 登录成功 · token ${esc(r.tokenMask)}`;
        $('#vo-ds-qr-box').style.display = 'none';
        $('#vo-ds-qr-finish').disabled = true;
        $('#vo-ds-qr-cancel').style.display = 'none';
        refreshDs();
      } else {
        o.innerHTML = `❌ ${esc(r.error)}` + (r.hint ? `<br><span class="muted">${esc(r.hint)}</span>` : '');
      }
    } catch (e) { o.textContent = '❌ ' + e.message; }
  });

  // ── 强制解锁（清锁 + 杀残留浏览器）──
  $('#vo-ds-qr-reset')?.addEventListener('click', async () => {
    const o = $('#vo-ds-qr-out');
    if (o) o.textContent = '正在清锁并终止残留浏览器…';
    try {
      const r = await api('/api/voice/ds/qr-reset', { method: 'POST', body: '{}' });
      if (o) o.textContent = r.ok ? '✅ ' + (r.note || '已解锁') : '❌ ' + r.error;
      const box = $('#vo-ds-qr-box');
      if (box) box.style.display = 'none';
      const fin = $('#vo-ds-qr-finish');
      if (fin) fin.disabled = true;
      const can = $('#vo-ds-qr-cancel');
      if (can) can.style.display = 'none';
    } catch (e) { if (o) o.textContent = '❌ ' + e.message; }
  });

  // ── 放弃扫码 ──
  $('#vo-ds-qr-cancel')?.addEventListener('click', async () => {
    try { await api('/api/voice/ds/qr-cancel', { method: 'POST', body: '{}' }); } catch { /* ignore */ }
    $('#vo-ds-qr-box').style.display = 'none';
    $('#vo-ds-qr-finish').disabled = true;
    $('#vo-ds-qr-cancel').style.display = 'none';
    out('#vo-ds-qr-out', '已放弃，浏览器进程已清理');
  });

  // ── 复制取 token 的代码片段 ──
  $('#vo-ds-copy')?.addEventListener('click', async () => {
    const code = "JSON.parse(localStorage.getItem('userToken')).value";
    try {
      await navigator.clipboard.writeText(code);
      out('#vo-ds-copy-out', '已复制 ✓');
    } catch {
      out('#vo-ds-copy-out', '复制失败，请手动选中上面那行');
    }
    setTimeout(() => out('#vo-ds-copy-out', ''), 2500);
  });

  // ── 保存粘贴的 token ──
  $('#vo-ds-token2-btn')?.addEventListener('click', async () => {
    const token = $('#vo-ds-token2')?.value.trim() || '';
    if (!token) { out('#vo-ds-token2-out', '先把 token 粘进来', true); return; }
    out('#vo-ds-token2-out', '校验并保存中…');
    try {
      const r = await api('/api/voice/ds/token', { method: 'POST', body: JSON.stringify({ token }) });
      if (r.ok) {
        out('#vo-ds-token2-out', `✅ 已保存（${r.tokenMask}）`);
        refreshAccounts();
        const inp = $('#vo-ds-token2'); if (inp) inp.value = '';
        refreshDs();
      } else {
        out('#vo-ds-token2-out', `❌ ${r.error}`, true);
      }
    } catch (e) { out('#vo-ds-token2-out', e.message, true); }
  });

  // ── 从远程浏览器读取登录态（备用：若服务器侧有登录态）──
  $('#vo-ds-import2')?.addEventListener('click', async () => {
    out('#vo-ds-import2-out', '正在读取浏览器里的 DS 登录态…');
    try {
      const r = await api('/api/voice/ds/import-browser', { method: 'POST', body: '{}' });
      if (r.ok) {
        out('#vo-ds-import2-out', `✅ 已导入（${r.tokenMask}）`);
        refreshDs();
      } else {
        out('#vo-ds-import2-out', `❌ ${r.error}`, true);
      }
    } catch (e) { out('#vo-ds-import2-out', e.message, true); }
  });

  // ── 微信扫码：nonce 换 token（已废弃：nonce 被页面抢先消费，保留接口供其他场景）──
  $('#vo-ds-nonce-btn')?.addEventListener('click', async () => {
    const raw = $('#vo-ds-nonce')?.value.trim() || '';
    if (!raw) { out('#vo-ds-nonce-out', '先把跳转后的地址贴进来', true); return; }
    out('#vo-ds-nonce-out', '正在用 nonce 换 token…');
    try {
      const r = await api('/api/voice/ds/login-nonce', { method: 'POST', body: JSON.stringify({ nonce: raw }) });
      if (r.ok) {
        out('#vo-ds-nonce-out', `✅ 登录成功（${r.provider}）· token ${r.tokenMask}`);
        refreshAccounts();
        const inp = $('#vo-ds-nonce');
        if (inp) inp.value = '';
        refreshDs();
      } else {
        out('#vo-ds-nonce-out', `❌ ${r.error}${r.hint ? ' —— ' + r.hint : ''}`, true);
      }
    } catch (e) { out('#vo-ds-nonce-out', e.message, true); }
  });

  // ── 发验证码 ──
  $('#vo-ds-send')?.addEventListener('click', async () => {
    const mobile = $('#vo-ds-mobile')?.value.trim() || '';
    out('#vo-ds-sms-out', '正在算 PoW 并请求验证码（约 5-15 秒）…');
    try {
      const r = await api('/api/voice/ds/send-code', { method: 'POST', body: JSON.stringify({ mobile }) });
      if (r.ok) { out('#vo-ds-sms-out', `✅ 验证码已发送（PoW 用时 ${r.powMs}ms）`); return; }
      if (r.needCaptcha) {
        out('#vo-ds-sms-out',
          `PoW 已通过（${r.powMs}ms），但 DS 要求「数美验证码」= 真人风控，插件不代过。\n`
          + '请点上方「打开官方登录页」在页面里登录，再用 token 方式接入（更快）。', true);
        return;
      }
      out('#vo-ds-sms-out', `❌ ${r.error || '发送失败'}${r.detail ? `（${r.detail}）` : ''}`, true);
    } catch (e) { out('#vo-ds-sms-out', e.message, true); }
  });

  // ── 短信登录 ──
  $('#vo-ds-login-btn')?.addEventListener('click', async () => {
    const mobile = $('#vo-ds-mobile')?.value.trim() || '';
    const code = $('#vo-ds-code')?.value.trim() || '';
    out('#vo-ds-sms-out', '登录中…');
    try {
      const r = await api('/api/voice/ds/login-sms', { method: 'POST', body: JSON.stringify({ mobile, code }) });
      if (r.ok) {
        out('#vo-ds-sms-out', `✅ 登录成功，token ${r.tokenMask}`);
        refreshDs();
      } else {
        out('#vo-ds-sms-out', `❌ ${r.error}${r.detail ? `（${r.detail}）` : ''}`, true);
      }
    } catch (e) { out('#vo-ds-sms-out', e.message, true); }
  });

  // ── 贴 token ──
  $('#vo-ds-token-btn')?.addEventListener('click', async () => {
    const token = $('#vo-ds-token')?.value.trim() || '';
    out('#vo-ds-token-out', '校验并保存中…');
    try {
      const r = await api('/api/voice/ds/token', { method: 'POST', body: JSON.stringify({ token }) });
      if (r.ok) {
        out('#vo-ds-token-out', `✅ 已保存（${r.tokenMask}）`);
        const inp = $('#vo-ds-token');
        if (inp) inp.value = '';
        refreshDs();
      } else {
        out('#vo-ds-token-out', `❌ ${r.error}`, true);
      }
    } catch (e) { out('#vo-ds-token-out', e.message, true); }
  });

  // ── 从浏览器导入 ──
  $('#vo-ds-import')?.addEventListener('click', async () => {
    out('#vo-ds-token-out', '正在从本机浏览器读取…');
    try {
      const r = await api('/api/voice/ds/import-browser', { method: 'POST', body: '{}' });
      if (r.ok) { out('#vo-ds-token-out', `✅ 已导入（${r.tokenMask}）`); refreshDs(); }
      else out('#vo-ds-token-out', `❌ ${r.error}`, true);
    } catch (e) { out('#vo-ds-token-out', e.message, true); }
  });

  // ── 登出 ──
  $('#vo-ds-logout')?.addEventListener('click', async () => {
    if (!confirm('确定删除本地保存的 DeepSeek 登录凭据？')) return;
    try {
      await api('/api/voice/ds/logout', { method: 'POST', body: '{}' });
      refreshDs();
    } catch (e) { alert(e.message); }
  });

  // ── 保存配置 ──
  $('#vo-save')?.addEventListener('click', async () => {
    try {
      await savePluginConfig('voice', {
        engine: currentEngine,
        ttsVoice: $('#vo-voice').value,
        ttsRate: $('#vo-rate').value,
        sttModel: $('#vo-model').value,
        autoTranscribe: $('#vo-auto').checked,
        dsVoice: $('#vo-dsvoice').value,
        dsMaxChars: Number($('#vo-dsmax').value) || 200,
        dsSessionId: $('#vo-dssession').value.trim()
      });
      alert('已保存');
    } catch (e) { alert(e.message); }
  });
  // ── 试音台（v1.9）──
  // 流程：POST /api/voice/preview?format=bin → 拿二进制音频 → Blob URL → <audio> 播放
  // 注意：内核给插件路由的默认响应是 JSON，音频走 `__raw` + buffer 回传。
  // 内核会加 Content-Disposition: attachment，但 fetch 拿 Blob 后自己造 objectURL
  // 就能直接播放，不受此影响。
  const tb = {
    mode: () => $('#vo-tb-mode')?.value || 'speak',
    engine: () => $('#vo-tb-engine')?.value || 'deepseek',
    // 朗读：取文本框
    text: () => ($('#vo-tb-text')?.value || '').trim(),
    // 唱歌：取两个独立字段
    singer: () => ($('#vo-tb-singer')?.value || '').trim(),
    song: () => ($('#vo-tb-song')?.value || '').trim(),
  };

  /**
   * 统一把当前输入收成后端要的形状。
   * 唱歌传 { singer, song } 对象（v1.9.2 后端已支持），朗读传字符串。
   */
  const tbPayload = () => (tb.mode() === 'lyric'
    ? { singer: tb.singer(), song: tb.song() }
    : tb.text());
  let tbCtrl = null;      // AbortController
  let tbUrl = null;       // 当前 objectURL（换新的要 revoke，否则内存泄漏）

  const tbOut = (msg) => { const o = $('#vo-tb-out'); if (o) o.textContent = msg || ''; };
  const tbSetBusy = (busy) => {
    const go = $('#vo-tb-go'), stop = $('#vo-tb-stop');
    if (go) { go.disabled = busy; go.textContent = busy ? '合成中…' : '合成并试听'; }
    if (stop) stop.disabled = !busy;
  };


  // 折叠区显示"实际发出的提示词"，避免用户看不懂为什么唱出来是那样
  const tbShowPrompt = async () => {
    const pre = $('#vo-tb-prompt');
    if (!pre) return;
    const payload = tbPayload();
    const empty = typeof payload === 'string' ? !payload : !payload.song;
    if (empty) { pre.textContent = tb.mode() === 'lyric' ? '（先填歌名）' : '（先输入内容）'; return; }
    try {
      const r = await api('/api/voice/preview-prompt', {
        method: 'POST',
        body: JSON.stringify({ text: payload, mode: tb.mode() })
      });
      pre.textContent = r?.prompt || '（拿不到）';
    } catch (e) { pre.textContent = '取提示词失败：' + e.message; }
  };

  // 模式切换 → 显示对应输入区，并更新提示（必须在 tbShowPrompt 定义之后立即调用）
  const tbSyncMode = () => {
    const isLyric = tb.mode() === 'lyric';
    const speakBox = $('#vo-tb-speak-box');
    const lyricBox = $('#vo-tb-lyric-box');
    const hint = $('#vo-tb-hint');
    if (speakBox) speakBox.style.display = isLyric ? 'none' : '';
    if (lyricBox) lyricBox.style.display = isLyric ? '' : 'none';
    if (hint) hint.innerHTML = isLyric
      ? '唱歌模式只填<b>歌手 + 歌名</b>，模板会自动套成：'
        + '<code>直接输出，XXX的《YYY》…预备，唱！</code>'
        + '。歌词由模型生成，<b>不用自己贴</b>。DS 引擎下只有部分账号能唱出旋律感。'
      : '朗读走「请只回复：【…】」，让模型原样复述，不加客套。';
    tbShowPrompt();
  };

  $('#vo-tb-mode')?.addEventListener('change', tbSyncMode);
  for (const sel of ['#vo-tb-text', '#vo-tb-singer', '#vo-tb-song']) {
    $(sel)?.addEventListener('input', () => { tbShowPrompt(); });
  }
  tbSyncMode();

  $('#vo-tb-go')?.addEventListener('click', async () => {
    const payload = tbPayload();
    const isLyric = tb.mode() === 'lyric';

    // 唱歌必须有歌名；歌手可留空（后端填「原唱」）
    if (isLyric) {
      if (!payload.song) { tbOut('❌ 先填歌名（歌手可留空，会自动用「原唱」）'); return; }
    } else if (!payload) {
      tbOut('❌ 先输入要朗读的文字');
      return;
    }

    // 旧的 objectURL 必须释放，否则每次试听都留一份音频在内存里
    if (tbUrl) { URL.revokeObjectURL(tbUrl); tbUrl = null; }
    const player = $('#vo-tb-player');
    if (player) player.style.display = 'none';

    tbSetBusy(true);
    tbOut('合成中…（DS 引擎要投递+PoW+合成，通常十几秒，长歌词更久）');
    tbCtrl = new AbortController();

    try {
      const res = await fetch('/api/voice/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: payload, mode: tb.mode(), engine: tb.engine() }),
        signal: tbCtrl.signal
      });

      const ctype = res.headers.get('content-type') || '';
      // 失败时后端回 JSON（带 error），成功时回 audio/mpeg
      if (!ctype.includes('audio')) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j?.error || msg; } catch { /* ignore */ }
        throw new Error(msg);
      }

      const blob = await res.blob();
      tbUrl = URL.createObjectURL(blob);

      const audio = $('#vo-tb-audio');
      const dl = $('#vo-tb-dl');
      const meta = $('#vo-tb-meta');
      if (audio) { audio.src = tbUrl; audio.play().catch(() => { /* 浏览器可能拦截自动播放 */ }); }
      if (dl) {
        dl.href = tbUrl;
        dl.download = `voice-${tb.mode()}-${Date.now()}.mp3`;
      }
      if (meta) {
        const kb = (blob.size / 1024).toFixed(1);
        meta.textContent = `${kb} KB · ${tb.engine()} · ${tb.mode() === 'lyric' ? '唱歌' : '朗读'}`;
      }
      if (player) player.style.display = '';

      const voice = res.headers.get('x-voice') || '';
      tbOut(`✅ 成功${voice ? `（音色 ${voice}）` : ''}，已在上方播放器就绪`);
    } catch (e) {
      tbOut(e?.name === 'AbortError' ? '已停止' : `❌ ${e.message}`);
    } finally {
      tbSetBusy(false);
      tbCtrl = null;
    }
  });

  $('#vo-tb-stop')?.addEventListener('click', () => {
    try { tbCtrl?.abort(); } catch { /* ignore */ }
    const a = $('#vo-tb-audio');
    if (a) { a.pause(); try { a.currentTime = 0; } catch { /* ignore */ } }
    tbOut('已停止');
    tbSetBusy(false);
  });
}

export default { mountPanel };
