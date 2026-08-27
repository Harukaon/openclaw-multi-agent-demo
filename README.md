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

Platform 不修改 OpenClaw。一个群内的人类 turn 按 Agent 成员加入顺序串行投递：A 完成后，Platform 将用户原话和 A 的可见回复拼入 `contentForAgent`，再投递给 B。Agent 没有有效贡献时输出精确的 `NO_REPLY`（大小写不敏感、不得附加其他文字），插件将其静默；可见回复才会写入群历史并传给下一 Agent。

Platform 同时向用户 WebSocket 推送 `pipeline.status`：状态栏显示当前由哪个 Agent 回复，以及每个 Agent 的 `等待中`、`回复中`、`已回复`、`已跳过`、`离线跳过` 或 `超时跳过` 状态；本轮所有成员处理完后显示 `已完成`。用户连接的 `hello.ok` 也会带上各群最新状态，刷新页面不会丢失当前状态。

## 关键约束

- 不在 feedmob2/feedmob3 上构建 Docker 镜像或编译项目。
- 镜像只通过 GitHub Actions 等外部 amd64 runner 构建，服务器只拉取已构建镜像。
- 不把 API key、token、cookie 或其他密钥放入仓库、日志和报告。
- 所有实现以实施计划为方向，但对 AI 生成内容逐项实测，不默认其接口和版本假设正确。
