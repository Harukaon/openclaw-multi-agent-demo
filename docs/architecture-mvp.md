# MVP 架构与实施边界

## 目标

先交付一个可真实验收的最小闭环：

1. Platform 保存 Human、Agent、Group、Membership、Message。
2. 一个 Agent 只建立一个 Platform WebSocket 连接。
3. Platform 按 `group_id` 做成员校验、稳定序号和 ACK，并按 `rootMessageId` 管理受控 Agent 广播回合。
4. OpenClaw Channel Plugin 将每个 `group_id` 映射为独立的 OpenClaw 群聊 Session；Platform 通过 `contentForAgent` 注入累计上下文，不修改 OpenClaw。
5. 三个独立 OpenClaw 容器连接同一个 Platform，完成多 Agent、多 Group 的并发广播端到端测试。
6. 提供最小可用的 HTTP API 和 WebSocket 协议；UI 在协议稳定后再做，避免先做不可验证的页面。

## 对原计划的现实校正

原计划的产品模型是正确方向，但不是可以直接复制的实现规格。本项目会逐项实测，尤其是：

- OpenClaw 2026.7.1-2 的 native Channel Plugin API 使用 `createChatChannelPlugin`、`gateway.startAccount` 和 `runtime.channel.inbound.run`；不把自定义频道误做成普通 tool plugin。
- OpenClaw 官方文档明确建议新频道使用 inbound `message` adapter 与 delivery adapter；MVP 先实现纯文本、单次发送和可验证 ACK，不宣称支持媒体、Thread、Voice 或 Poll。
- Group Session 的关键身份是稳定 `group_id`，不是群名、连接 ID 或消息内容。
- Platform 的消息历史是事实源；OpenClaw Session 只是某个 Agent 在某个 Group 的上下文。
- “一个 Agent 一个 WebSocket”与“一个 Agent 多个 Group Session”是两个不同层次，必须分别测试。
- Agent 注册后不自动入群；只有 `group_members(member_type=agent, member_id=...)` 存在时才接收该群消息。
- 演示版 Platform REST 写操作不启用 Admin token；API 仅适用于受控演示网络，不应直接暴露公网。

## Platform MVP

技术选型：Node.js 22.23.2 + TypeScript + Express + `ws` + Node 内置 `node:sqlite`。Platform 镜像由外部 amd64 GitHub Actions 构建；feedmob2/feedmob3 只拉取镜像和运行容器。

核心表：

- `users`
- `agents`
- `groups`
- `group_members`
- `agent_group_state`
- `messages`
- `message_deliveries`

所有群消息保存 `group_id`，序号按 `(group_id, seq)` 递增。所有写消息的入口都校验发送者仍是该群成员。Agent 连接认证使用一次性生成的 Agent token；数据库只保存 token hash。

## WebSocket MVP 协议

Agent → Platform：

- `hello { agentId, token }`
- `ack { groupId, messageId, seq }`
- `agent.message { groupId, content, parentMessageId?, rootMessageId? }`
- `ping`

Platform → Agent：

- `hello.ok { agent, groups }`
- `message { group, seq, sender, content, contentForAgent, mentions, deliveryContext }`
- `replay.end { groupId, lastSeq }`
- `error { code, message }`
- `pong`

用户 → Platform：

- `hello { userId }`
- `user.message { groupId, content, parentMessageId?, rootMessageId? }`
- `ping`

Platform → 用户：

- `hello.ok { groups, broadcastStatuses }`
- `message { group, seq, sender, content, mentions, parentMessageId?, rootMessageId?, depth, createdAt }`
- `broadcast.status { group, turnId, rootMessageId, state, activeAgents, agentReplyCount, maxAgentReplies, agents, updatedAt }`
- `message.suppressed { clientMessageId?, groupId, reason }`
- `error { code, message }`
- `pong`

`deliveryContext` 至少包含：`groupId`、`groupName`、`mentionState`、`selfMessage`。广播投递还包含 `broadcast { turnId, rootMessageId, depth, agentReplyCount, maxAgentReplies }`。Mention 状态限定在当前 Group：`SELF`、`DIRECT`、`OTHER`、`NONE`。`contentForAgent` 由 Platform 针对每个 Agent 注入当前群组、发送者、Mention 状态和累计对话；没有有效贡献时，提示 Agent 输出精确 `NO_REPLY`，插件将其静默，不写回群消息。`content` 始终保留当前原始消息。

`broadcast.status.state` 为 `broadcasting` 或 `completed`；`activeAgents` 表示当前等待/回复中的 Agent，`agentReplyCount/maxAgentReplies` 表示根消息回复预算，`agents[].status` 为 `waiting`、`replying`、`replied`、`no_reply`、`offline`、`timeout` 或 `limit`。状态按 Group 广播给 Human 成员；`hello.ok.broadcastStatuses` 用于页面重连后恢复各群最新状态。每个 `(turnId, messageId, agentId)` 只投递一次，每个 Agent 的同群投递串行化；暂停、重置、断线和 replay 不会启动新的旧回合。

## Channel Plugin MVP

插件负责：

- 使用配置的 Platform WebSocket 地址和 Agent token 连接；
- 把 `message.group.id` 变成 OpenClaw 的稳定 group peer；
- 把 Platform 的 sender、mentions、delivery context 和累计广播提示词注入当前 Agent turn；
- 将 OpenClaw 的文本回复通过同一连接写回原 `group_id`；精确 `NO_REPLY` 不写回；
- ACK、断线重连和每群 replay；回放消息只观察并 ACK，不启动新的 Agent turn。

插件不负责创建群、管理 Human、选择成员或定义 Agent 角色。

参考官方开发文档：<https://docs.openclaw.ai/plugins/sdk-channel-plugins.md>

## 三实例部署约定

- `openclaw-a`、`openclaw-b`、`openclaw-c` 使用由现有 `ghcr.io/harukaon/feedmob-openclaw-cf:latest` 派生、并在外部 runner 内置本插件的镜像。
- 不在任何云服务器执行 `docker build`、`npm install` 或 TypeScript 编译。
- 插件通过外部构建的派生 OpenClaw 镜像进入容器；Platform 镜像同样由外部 amd64 runner 构建。
- 测试配置、Token、API key、Cookie 不提交到仓库，不写入报告。
- 三实例只使用演示模型配置，默认关闭不需要的外部 Channel，避免影响现有生产服务。

## 验收顺序

1. Platform health、SQLite migration、单 Agent hello。
2. Fake Agent 覆盖范围：Agent A ∈ G1/G2，Agent B ∈ G1，Agent C ∈ G2。
3. Mention 状态和 group-scoped seq。
4. 一个真实 OpenClaw + 一个 Group。
5. 一个真实 OpenClaw + 两个 Group，确认 Session 不串。
6. 三个真实 OpenClaw + 两个/三个 Group，确认并行广播、Agent 间 @ 回流、回复预算和 Group 隔离。
7. 断线、ACK、重连 replay、Group Pause/Reset，确认 replay 不重新触发 turn。
8. 最后再做 UI 和演示手册。

未实现的能力必须明确标记为未实现，不用“看起来能工作”的假成功替代测试证据。
