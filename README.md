# 声音·克隆版（voice-clone）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/github/v/release/Joilkkerlklkj/voice-clone?label=version)](https://github.com/Joilkkerlklkj/voice-clone/releases)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-BG--QQagent%20%7C%20OneBot-blue)](https://github.com/lyyde599/BG-QQagent-v3.0)
[![Downloads](https://img.shields.io/github/downloads/Joilkkerlklkj/voice-clone/total)](https://github.com/Joilkkerlklkj/voice-clone/releases)


> 给「鲸界Bridge」QQ 机器人用的语音插件：**会发语音、听得懂语音，还能用你自己的声音说话**。
> 版本 **v1.0.0** ｜ 作者 **DSH** ｜ MIT

本插件基于「基础语音与唱歌 1.9.4」（作者：白光）改编，保留原有 edge / DeepSeek 两条 TTS 链路
与语音识别，新增 **MiniMax 声音克隆引擎**——上传一段干净人声，就能把任意文字用那个音色念出来。

> 仓库**不含任何克隆音源**（没有训练样本、没有 voice_id、没有 API Key）。
> 音色需要你自己在 MiniMax 平台克隆后，把 `voice_id` 填进配置。

---

## 能力

| 工具 | 作用 |
|:--|:--|
| `send_voice(text, engine?, mode?)` | 把文字合成 QQ 语音气泡发出去 |
| `hear_voice(messageId)` | 把某条语音消息转成文字（本地 faster-whisper） |

可选 `autoTranscribe`：群友发语音时自动转写进消息正文，模型看到的是
`[语音·转写] 他说的话`，而不是干巴巴的 `[语音]`。

## 三个引擎

| 引擎 | 声音来源 | 速度 | 成本 | 适用 |
|:--|:--|:--|:--|:--|
| `edge`（默认） | 微软在线音色（晓晓/云希等 6 款） | 秒级 | 免费无 key | 日常说话 |
| `deepseek` | DeepSeek 网页「朗读」音色（贝壳/白浪/海星/暗潮） | 10 秒+ | 需 DS 登录态 | 想要官方那种声音 |
| `minimax` | **你自己克隆的音色**（MiniMax voice_clone） | 2–5 秒 | 按字符计费 | 专属音色、角色扮演 |

调用时可以按次指定引擎：`send_voice({text:"...", engine:"minimax"})`；不传就用配置里的 `engine`。

---

## 安装

### 1）必需（主链路）

- Node ≥ 18 + 内核自带的 `ws`
- `ffmpeg`（在 PATH 里）
- 权限：`send`、`read-media`、`exec`

### 2）可选：edge 引擎

```bash
python3 -m venv plugins/voice-clone/.venv
plugins/voice-clone/.venv/bin/pip install edge-tts
```

### 3）可选：语音识别 hear_voice

```bash
plugins/voice-clone/.venv/bin/pip install faster-whisper "av<13"
```

> ⚠️ `av` 必须 `<13`：faster-whisper 调用 `av.open(metadata_errors=...)`，
> 该参数在 av≥13 已被移除，装新会直接 TypeError。

### 4）一键自检 / 安装

```bash
bash setup.sh            # 只自检
bash setup.sh --install  # 缺什么装什么
```

## 配置

在控制台「插件 → 声音·克隆版」里改，或直接改 `data/plugins/voice-clone/config.json`。

| 字段 | 默认 | 说明 |
|:--|:--|:--|
| `enabled` | false | 插件总开关 |
| `engine` | `edge` | 默认引擎：`edge` / `deepseek` / `minimax` |
| `ttsVoice` | `zh-CN-XiaoxiaoNeural` | edge 音色 |
| `ttsRate` / `ttsPitch` | `+0%` / `+0Hz` | edge 语速/音调 |
| `maxTextLength` | 300 | 单条语音字数上限 |
| `sttModel` | `small` | whisper 模型（tiny/base/small/medium） |
| `sttLanguage` | `zh` | 识别语言 |
| `autoTranscribe` | true | 自动转写群友语音 |
| `mm.apiKey` | `""` | **MiniMax API Key**（必填才能用克隆引擎） |
| `mm.voiceId` | `""` | **克隆得到的音色 ID** |
| `mm.model` | `speech-02-hd` | MiniMax TTS 模型（`speech-02-hd` / `speech-02-turbo`） |
| `mm.speed` | 1 | 语速倍率（0.5–2） |
| `dsVoice` | `mira` | DeepSeek 音色（mira/echo/stella/tide） |

## 用 MiniMax 克隆自己的声音

### 1）准备样本

- **10 秒 ~ 5 分钟**干净人声，单人、无 BGM、无混响、无回声；
- 有伴奏的歌要先做人声分离（例如 `demucs --two-stems=vocals`），再降噪、EQ；
- 多段素材可以拼接，**样本越长音色越稳**（3 分钟左右效果明显更好）。

### 2）上传并克隆

```bash
# ① 上传样本（purpose=voice_clone）
curl -X POST https://api.minimaxi.com/v1/files/upload \
  -H "Authorization: Bearer $MINIMAX_KEY" \
  -F "purpose=voice_clone" -F "file=@sample.wav;type=audio/wav"
# → { "file": { "file_id": 123456 } }

# ② 克隆（voice_id 自己起名，全账号唯一）
curl -X POST https://api.minimaxi.com/v1/voice_clone \
  -H "Authorization: Bearer $MINIMAX_KEY" -H 'content-type: application/json' \
  -d '{"file_id":123456,"voice_id":"my_voice_v1","text":"你好，这是我的新声音"}'
# → { "demo_audio": "https://...mp3", "base_resp": {"status_code":0} }
```

> 账号需要**已开通「声音复刻」权限**。没开通时返回
> `2038 voice clone user forbidden`，去 MiniMax 控制台申请/实名后即可。

### 3）填进配置并切换

```json
{ "engine": "minimax",
  "mm": { "apiKey": "sk-...", "voiceId": "my_voice_v1", "model": "speech-02-hd", "speed": 1 } }
```

### 4）失败降级

`minimax` 调用失败（额度、限流、权限）会自动降级到 `edge`，并把真实原因写进工具返回。

---

## 工具参数

### send_voice

```json
{ "text": "要说的话（建议 ≤60 字，最多 300）",
  "engine": "edge | deepseek | minimax",
  "mode": "speak | lyric" }
```

- `mode=lyric` 用于"唱"的语感（需 deepseek 登录态）；
- 语音消息**不会带引用**——QQ 里被引用包住的语音条点不开，这是刻意为之。

### hear_voice

```json
{ "messageId": 123456 }
```

返回：`{ text, language, durationSec }`。纯本地识别，不上传音频。

## 常见问题

| 现象 | 原因 / 处理 |
|:--|:--|
| `send_voice` 报"语音全线失败" | ffmpeg 不在 PATH，或 edge 的 python 环境没装 |
| 语音发出去但点不开 | 检查是否被 `reply` 段包住（本插件已强制去掉引用） |
| `minimax` 返回 2038 | MiniMax 账号未开通声音复刻权限 |
| `minimax` 返回 2049 | key 与域名不匹配（国内 key 只能用 `api.minimaxi.com`） |
| 识别很慢 | whisper 默认 small；改 `sttModel=tiny/base` 或换更快的机器 |
| 装 `av` 后识别报 TypeError | `av` 版本 ≥13，降到 `av<13` |

## 变更记录

### v1.0.0（2026-11-01）

- 新增 **MiniMax 声音克隆引擎**（`engine=minimax`）：用 `mm.apiKey` + `mm.voiceId`
  合成语音，失败自动降级 edge；
- 引擎枚举从 `edge/deepseek` 扩到 `edge/deepseek/minimax`；
- 配置新增 `mm.{apiKey,voiceId,model,speed}`；
- 保留原有 edge / DeepSeek 官方音色 / faster-whisper 识别 / 自动转写能力；
- 发布包**不含任何音源、密钥或 voice_id**。

## 许可

MIT。基于「基础语音与唱歌 1.9.4」（作者：白光）改编。
克隆他人声音前请取得授权，遵守当地法律与平台规则。

---

## 目录结构

```
voice-clone/
├── manifest.json      插件元信息
├── index.js           插件主体（send_voice / hear_voice / 自动转写 / minimax 引擎）
├── ui.js              控制台面板
├── config.json        默认配置（不含任何密钥）
├── setup.sh           依赖自检/安装
├── pow.js             DeepSeek 投递 PoW
├── ds-auth.js         DeepSeek 登录态
├── ds-deliver.js      DeepSeek 投递
├── deepseek-tts.js    DeepSeek 朗读合成
├── page-deliver.js    页面投递兜底
├── qr-login.js        扫码登录
├── assets/            wasm 等随包资源
└── ENV.md             环境说明
```

---

## 相关文档

- [关闭 SnowLuma 内置 `#sl` 状态命令](docs/snowluma-status-command.md) —— 解决「发 #sl 机器人没反应 / 被协议端抢答」的问题
