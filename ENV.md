# voice 插件环境依赖（分层）

> 这个文件是为「插件包自包含」准备的 —— 导入方照这份清单能一键复原环境。
> 关键区分：**DeepSeek 音色主链路不需要 Python**，只要 Node + ws + ffmpeg。

## 第一层：主链路（DeepSeek 官方音色）—— 必需

| 依赖 | 来源 | 说明 |
|:--|:--|:--|
| Node.js ≥ 18 | 系统 | 内核本来就要求 |
| `ws` | 内核 node_modules | 内核 package.json 已含 `ws@^8`，**插件不必单独装** |
| `assets/deepseek-hash.wasm` | **随包分发**（26KB） | PoW 计算，纯计算无网络 |
| `ffmpeg` | 系统 | PCM→MP3 转码（NapCat 转 silk 也用它） |

**这一层齐了，「用 DeepSeek 音色朗读/唱歌」就完全可用** —— 不碰 Python、不碰浏览器。

```bash
# 自检
node -e "require.resolve('ws')" && echo "ws OK"
command -v ffmpeg && echo "ffmpeg OK"
ls plugins/voice/assets/deepseek-hash.wasm && echo "wasm OK"
```

## 第二层：edge 引擎（微软免费音色）—— 可选

| 依赖 | 说明 |
|:--|:--|
| Python ≥ 3.8 | 本机 3.12 / 阿里云的默认 3.6 **不够**，要用 python3.11 |
| `edge-tts` | 微软在线接口，免费无限，无需 key |

```bash
python3 -m venv plugins/voice/.venv
plugins/voice/.venv/bin/pip install edge-tts
```

不用 edge 引擎可以不装。

## 第三层：语音识别 hear_voice（whisper）—— 可选

| 依赖 | 说明 |
|:--|:--|
| `faster-whisper` | 本地识别，语音不出机器 |
| **`av<13`** | 🔴 必须 <13 |

**`av<13` 不是保守，是硬约束（本机实测）**：

```text
av 19.0.1 + faster-whisper 1.2.1
→ TypeError: open() got an unexpected keyword argument 'metadata_errors'
```

`faster-whisper` 内部调 `av.open(metadata_errors=...)`，该参数在 `av>=13` 已移除。
装最新版会直接崩。固定版本：

```bash
plugins/voice/.venv/bin/pip install faster-whisper "av<13"
```

首次运行还会下载 whisper 模型（tiny≈75MB / small≈500MB），之后走本地缓存。

## 一键安装（第二层 + 第三层）

```bash
cd plugins/voice
PY=$(command -v python3.11 || command -v python3.12 || command -v python3)
$PY -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q edge-tts faster-whisper "av<13"
.venv/bin/python3 -c "import edge_tts, faster_whisper, av; print('av', av.__version__)"
```

装完 `av` 应该是 12.x，不是 19.x。

## 🔴 关于 venv 能不能随包分发：不能

本机 `.venv` 是 **364MB / 5070 文件 / 85 个 `.so`**，且：

- CPU 架构绑定：本机 `aarch64`，阿里云 `x86_64` → `.so` 直接加载失败
- `shebang` 写死绝对路径 `/home/lyy/QQbot/...`
- 目标机 Python 版本可能不匹配

**跨机器传递 venv 一定坏**。内核的 `EXPORT_EXCLUDE_DIRS` 已把 `.venv` 排除，
这是正确的设计，不要绕过。替代做法：包内带这份清单 + 上面的安装脚本，
每台机器各自建本地 venv。

## 可选：浏览器相关功能（默认不启用）

以下功能需要 Chrome，**主链路不用**：

| 功能 | 文件 | 何时需要 |
|:--|:--|:--|
| `dsDeliverMode: page/hybrid` | `page-deliver.js` | 纯 Node 投递被 DS 前端新校验挡住时的兜底 |
| 二维码直出面板 | `qr-login.js` | 仅境内 IP（阿里云）有意义；美国出口 IP 不提供微信扫码 |
| 从本机浏览器导入 token | `ds-auth.js` 的 `readTokenFromBrowser` | 可选便捷通道 |

都不装也能用：`dsDeliverMode` 默认 `node`，登录用「贴 token」即可。
