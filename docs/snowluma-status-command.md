# 关掉 SnowLuma 内置的 `#sl` 状态命令

> 现象：在 QQ 里发 `#sl`，会收到一段「SnowLuma 状态」，像是机器人被谁抢答了。
> 原因：那是 **SnowLuma 协议端自带的命令**，跟「鲸界Bridge」机器人无关。

## 根因

SnowLuma 的账号配置在容器内：

```
/app/data/config/onebot_<uin>.json
```

里面有一段：

```json
"statusCommand": {
  "enabled": true,
  "swallow": false,
  "cooldownSeconds": 5,
  "trigger": "#sl"
}
```

`enabled: true` 时，任何人（好友/群）发 `#sl`，SnowLuma 自己直接回状态，
消息不会再进 OneBot，机器人根本没收到 —— 所以表现成"机器人答非所问 / 突然报状态"。

## 修复

不用重启容器（重启会掉 QQ 登录、要重新扫码），走 SnowLuma 的 WebUI API 热更新：

```bash
# ① 登录（WebUI 的 admin 密码）
TOK=$(curl -sS -X POST http://127.0.0.1:5099/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"你的密码"}' | jq -r .token)

# ② 读账号配置
curl -sS -H "Authorization: Bearer $TOK" \
  http://127.0.0.1:5099/api/config/<uin> > cfg.json

# ③ 把 statusCommand.enabled 改成 false（其余字段原样保留），再 POST 回去
#    注意：POST 的 body 是 config 本体，不是 {"config": ...}
curl -sS -X POST -H "Authorization: Bearer $TOK" \
  -H 'content-type: application/json' -d @cfg.json \
  http://127.0.0.1:5099/api/config/<uin>
```

成功响应：

```json
{"success":true,"saved":true,"applied":true,"online":true,"errors":[]}
```

- `applied: true` → 立即生效（不用重启 SnowLuma）
- `saved: true` → 已写回 `onebot_<uin>.json`，重启也保持
- `online: true` → QQ 没掉线

## 脚本

仓库里带了一个一键脚本（含 `--enable` 反向开关）：

```bash
SNOWLUMA_UIN=3277803212 \
SNOWLUMA_PASS='你的 WebUI 密码' \
bash scripts/snowluma-disable-status.sh

# 重新打开
SNOWLUMA_UIN=3277803212 SNOWLUMA_PASS='...' \
bash scripts/snowluma-disable-status.sh --enable
```

可选环境变量：`SNOWLUMA_WEBUI`（默认 `http://127.0.0.1:5099`）、`SNOWLUMA_USER`（默认 `admin`）。

## 验证

```bash
# 配置里应为 false
curl -sS -H "Authorization: Bearer $TOK" \
  http://127.0.0.1:5099/api/config/3277803212 | jq .config.statusCommand
```

再从手机发一次 `#sl`：不再出现 SnowLuma 状态；消息会作为普通消息进 OneBot，
由机器人按正常对话处理。

## 备注

- 改之前建议备份配置：`docker cp snowluma:/app/data/config/onebot_<uin>.json ./backup.json`
- 只想"静默吞掉"而不是关闭，可保留 `enabled` 但把 `trigger` 改成别人猜不到的词（`swallow` 控制是否吞消息）；
- 关闭后 `#sl` 会落到机器人那边；如果连机器人也不想理它，需要在机器人侧加一条忽略规则。
