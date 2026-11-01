#!/usr/bin/env bash
# 开关 SnowLuma 内置的 #sl 状态命令（热生效，不重启容器、不掉 QQ）
#
# 用法：
#   SNOWLUMA_UIN=3277803212 SNOWLUMA_PASS='你的 WebUI 密码' bash scripts/snowluma-disable-status.sh
#   SNOWLUMA_UIN=3277803212 SNOWLUMA_PASS='...' bash scripts/snowluma-disable-status.sh --enable
#
# 可选环境变量：
#   SNOWLUMA_WEBUI   默认 http://127.0.0.1:5099
#   SNOWLUMA_USER    默认 admin
#   SNOWLUMA_UIN     必填，账号 QQ 号
#   SNOWLUMA_PASS    必填，SnowLuma WebUI 密码
#
# 说明：SnowLuma 的账号配置在 /app/data/config/onebot_<uin>.json，
#       statusCommand.enabled=true 时任何人发 #sl 都会收到一段「SnowLuma 状态」，
#       会跟机器人抢答。这里通过 WebUI API 改成 false，配置会持久化。
set -euo pipefail

BASE="${SNOWLUMA_WEBUI:-http://127.0.0.1:5099}"
USER_NAME="${SNOWLUMA_USER:-admin}"
UIN="${SNOWLUMA_UIN:?请设置 SNOWLUMA_UIN（账号 QQ 号）}"
PASS="${SNOWLUMA_PASS:?请设置 SNOWLUMA_PASS（WebUI 密码）}"
ENABLE=0
[ "${1:-}" = "--enable" ] && ENABLE=1

echo "→ 登录 $BASE …"
LOGIN_BODY=$(python3 -c 'import json,os;print(json.dumps({"username":os.environ["SNOWLUMA_USER"],"password":os.environ["SNOWLUMA_PASS"]}))')
TOK=$(curl -sS -X POST "$BASE/api/login" -H 'content-type: application/json' -d "$LOGIN_BODY" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
if [ -z "$TOK" ]; then
  echo "✗ 登录失败（检查 SNOWLUMA_USER / SNOWLUMA_PASS）" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ 读取账号 $UIN 配置 …"
curl -sS -H "Authorization: Bearer $TOK" "$BASE/api/config/$UIN" > "$TMP/cfg.json"

echo "→ 写入 statusCommand.enabled=$([ "$ENABLE" = 1 ] && echo true || echo false) …"
python3 - "$TMP/cfg.json" "$TMP/save.json" "$ENABLE" <<'PY'
import json, sys
src, dst, enable = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
d = json.load(open(src))
cfg = d.get('config') or d
sc = cfg.setdefault('statusCommand', {})
sc['enabled'] = enable
json.dump(cfg, open(dst, 'w'), ensure_ascii=False)
print('   statusCommand =', json.dumps(sc, ensure_ascii=False))
PY

echo "→ 提交（热生效）…"
curl -sS -X POST -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d @"$TMP/save.json" "$BASE/api/config/$UIN" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("   saved:",d.get("saved"),"applied:",d.get("applied"),"online:",d.get("online"),"errors:",d.get("errors"))'
