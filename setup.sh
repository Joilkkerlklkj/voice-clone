#!/usr/bin/env bash
# voice 插件环境自检 + 可选安装
#
# 用法：
#   bash setup.sh            # 只自检，不改动任何东西
#   bash setup.sh --install  # 缺什么装什么（第二层+第三层）
#
# 设计原则：主链路（DeepSeek 音色）零 Python 依赖，所以自检分三层报，
#          第一层不全才报 FAIL（真影响功能），二三两层只是 WARN。

set -u
cd "$(dirname "$0")" || exit 1

INSTALL=0
[ "${1:-}" = "--install" ] && INSTALL=1

ok=0; warn=0; bad=0
say_ok()   { echo "  ✅ $1"; ok=$((ok+1)); }
say_warn() { echo "  ⚠️  $1"; warn=$((warn+1)); }
say_bad()  { echo "  ❌ $1"; bad=$((bad+1)); }

echo "═══ voice 插件环境自检 ═══"
echo

# ── 第一层：主链路（DeepSeek 音色）───────────────
echo "【第一层】主链路（DeepSeek 官方音色）—— 必需"
node -v >/dev/null 2>&1 && say_ok "node $(node -v)" || say_bad "缺 node"

# ws 从内核 node_modules 解析（插件不单独装）
if node -e "require.resolve('ws')" >/dev/null 2>&1; then
  say_ok "ws 可解析（内核 node_modules）"
else
  say_bad "ws 不可解析 —— 内核依赖缺失，在项目根目录跑 npm install"
fi

[ -f assets/deepseek-hash.wasm ] && say_ok "PoW wasm 在包内（$(stat -c%s assets/deepseek-hash.wasm) 字节）" \
  || say_bad "缺 assets/deepseek-hash.wasm —— PoW 无法计算"

if command -v ffmpeg >/dev/null 2>&1; then
  say_ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9.]+' | head -1) @ $(command -v ffmpeg)"
else
  say_bad "缺 ffmpeg（PCM→MP3 与 NapCat 转 silk 都要）"
fi
echo

# ── 第二层：edge 引擎 ────────────────
echo "【第二层】edge 引擎（微软免费音色）—— 可选"
PY=""
for c in ./\.venv/bin/python3 python3.11 python3.12 python3; do
  if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then PY="$c"; break; fi
done

if [ -z "$PY" ]; then
  say_warn "找不到 python3"
else
  ver=$("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo "?")
  if [ "$ver" = "?" ]; then
    say_warn "$PY 版本取不到"
  elif [ "$(printf '%s\n3.8\n' "$ver" | sort -V | head -1)" = "$ver" ]; then
    say_warn "python $ver 低于 3.8（$PY）—— edge/whisper 需要 ≥3.8"
  else
    say_ok "python $ver（$PY）"
  fi
  if "$PY" -c 'import edge_tts' >/dev/null 2>&1; then
    say_ok "edge-tts 已装"
  else
    say_warn "edge-tts 未装 → edge 引擎不可用（不影响 DeepSeek 音色）"
  fi
fi
echo

# ── 第三层：whisper 识别 ────────────────
echo "【第三层】语音识别 hear_voice —— 可选"
if [ -n "$PY" ] && "$PY" -c 'import faster_whisper' >/dev/null 2>&1; then
  say_ok "faster-whisper 已装"
  AVV=$("$PY" -c 'import av;print(av.__version__)' 2>/dev/null || echo "?")
  case "$AVV" in
    1[3-9].*|[2-9][0-9].*)
      say_warn "av $AVV 太新 → faster-whisper 会报 metadata_errors，装 av<13（只影响识别）"
      ;;
    ?) say_warn "av 版本取不到" ;;
    *) say_ok "av $AVV（满足 <13）" ;;
  esac
else
  say_warn "faster-whisper 未装 → hear_voice 不可用（不影响发音）"
fi
echo

# ── 汇总 ────────────────
echo "─── 汇总：$ok 正常 / $warn 警告 / $bad 致命 ───"
if [ "$bad" -eq 0 ]; then
  echo "第一层完整，DeepSeek 音色朗读与唱歌可用。"
else
  echo "🔴 第一层有缺失，主链路不可用，请先补齐上面的 ❌ 项。"
fi

if [ "$warn" -gt 0 ]; then
  echo
  echo "提示：第二/三层缺失只影响 edge 引擎与语音识别，不影响 DeepSeek 音色。"
  echo "      要装：bash setup.sh --install"
fi

# ── 安装 ────────────────
if [ "$INSTALL" -eq 1 ]; then
  echo
  echo "═══ 开始安装第二层 + 第三层 ═══"
  if [ -z "$PY" ]; then
    echo "找不到 python3，放弃。"; exit 1
  fi
  if [ ! -d .venv ]; then
    echo "→ 建 venv：$PY -m venv .venv"
    "$PY" -m venv .venv || { echo "建 venv 失败"; exit 1; }
  fi
  echo "→ pip install edge-tts faster-whisper 'av<13'"
  .venv/bin/pip install -q --upgrade pip 2>/dev/null
  .venv/bin/pip install -q edge-tts faster-whisper "av<13" || { echo "安装失败"; exit 1; }
  .venv/bin/python3 - <<'PYEOF'
import av, edge_tts, faster_whisper
print(f"  ✅ 装好了：edge-tts / faster-whisper / av {av.__version__}")
if int(av.__version__.split('.')[0]) >= 13:
    raise SystemExit("  ❌ av 版本仍 >= 13，faster-whisper 会崩")
PYEOF
  echo "→ 完成，重跑 bash setup.sh 复查"
fi

if [ "$bad" -eq 0 ]; then exit 0; else exit 1; fi
