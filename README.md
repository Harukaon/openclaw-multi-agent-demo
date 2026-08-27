# OpenClaw 多 Agent 多群聊演示平台

本项目用于实现并验证“多 Human + 多 OpenClaw Agent + 多 Group”的端到端演示平台。

## 目录

- `docs/`：需求与实施计划原文、设计决策
- `platform/`：群聊平台服务端与数据模型
- `plugins/`：OpenClaw Channel Plugin
- `deploy/`：服务器部署文件与无密钥配置模板
- `tests/`：自动化与端到端测试
- `artifacts/`：测试报告、验收证据与其他产物

## 当前验收拓扑

今晚先用 [`deploy/single-host/`](deploy/single-host/) 在 feedmob2 单机运行：Platform 与三个 OpenClaw Agent 通过 Compose 内网通信，Gateway 仅占用宿主机 `18790/18791/18792`，现有 `openclaw-cf:18789` 保持不变。明天再把 Platform 或一个 Agent 拆到 feedmob3，并切换到内网地址或正式 HTTPS 域名。

Compose 已为 Platform 配置 `384m` 上限/`256m` 保留，为每只 OpenClaw+Camofox 配置 `768m` 上限/`512m` 保留。验收门槛是宿主机至少保留 `500MiB` 可用内存，目标 `1GiB`；低于门槛先停 Agent C，再迁移，不影响现有服务。

## 消息编排

Platform 不修改 OpenClaw。人类消息开启一个按 `rootMessageId` 隔离的受控广播回合：所有在线 Agent 并行收到带有**当前群组完整历史**的 `contentForAgent`。Agent 回复会实时广播给其他成员，并继续触发其他 Agent 的正常回合；由提示词中的身份、历史和 `NO_REPLY` 规则控制是否继续回复。Agent 没有有效贡献时必须输出精确的 `NO_REPLY`（大小写不敏感、不得附加其他文字），插件将其静默；Agent 不会收到自己的消息。`@all` 会明确提及群内全部成员。

每个根消息默认最多允许 12 条可见 Agent 回复，可通过 `BROADCAST_MAX_AGENT_REPLIES` 配置；回合在所有投递 ACK 完成并经过短暂结算窗口后结束。重复投递通过 `(turnId, messageId, agentId)` 去重，每个 Agent 在同一群组使用串行投递队列，暂停、重置、断线和 replay 都不会重新启动旧回合。

Platform 向用户 WebSocket 推送 `broadcast.status`：状态栏显示并发回复 Agent、每个 Agent 的决策状态和 `已回复/最大回复数` 预算。用户连接的 `hello.ok` 也会带上各群最新 `broadcastStatuses`，刷新页面不会丢失状态。

## Web 端进入方式

打开群聊页面后必须先输入用户名进入，不再默认使用 Leo，也没有用户下拉切换。已存在的用户名会恢复同一用户身份；首次输入的新用户名会创建一个演示用户，因此 Leo、Wendy 可以在不同浏览器/标签页同时在线。用户名登录是演示身份声明，不是密码认证；生产环境仍需接入真正的认证系统。

Platform 会按当前用户过滤群组列表，并对群组详情和消息接口再次校验 human 成员关系；未被邀请的用户收到 404，不会获得群成员和历史消息。消息正文支持安全的 Markdown 渲染，Agent A/B/C 使用不同颜色区分。

## 关键约束

- 不在 feedmob2/feedmob3 上构建 Docker 镜像或编译项目。
- 镜像只通过 GitHub Actions 等外部 amd64 runner 构建，服务器只拉取已构建镜像。
- 不把 API key、token、cookie 或其他密钥放入仓库、日志和报告。
- 所有实现以实施计划为方向，但对 AI 生成内容逐项实测，不默认其接口和版本假设正确。
