# Trae 自动签到插件

打开编辑器自动领取 Trae 每日积分签到奖励（就是客户端「每日领 100 积分」的签到按钮）。

## 原理

- 读取本机 Trae 客户端登录态（`%APPDATA%\Trae CN\User\globalStorage\storage.json`，只读不改）
- 解密出 accessToken 后调用官方签到接口（`api.trae.cn`）
- 先查状态、未签才领取，天然幂等，不会重复领

## 功能

- 启动 Trae 时自动签到（每天最多一次，跨天自动补签）
- 状态栏显示签到状态，点击可手动签到
- 命令面板：`Trae 签到：立即签到`、`Trae 签到：查看积分余额`
- 失败自动重试（默认 30 分钟，可配置）

## 设置项

| 设置 | 默认 | 说明 |
|---|---|---|
| `traeAutoCheckin.enabled` | `true` | 启动时自动签到 |
| `traeAutoCheckin.showNotifications` | `true` | 签到结果弹通知 |
| `traeAutoCheckin.retryMinutes` | `30` | 失败重试间隔（分钟） |

## 安全说明

- 令牌仅存内存，不打印、不落盘、不上传
- 仅操作本人本机账号，不做任何绕过验证的行为
- 解密方式与接口为官方客户端行为的逆向实现，客户端大版本更新后可能需要跟进调整
