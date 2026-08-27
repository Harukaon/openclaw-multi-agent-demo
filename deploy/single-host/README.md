# 单机验收部署（feedmob2）

此目录用于今晚的本地化验收：Group Platform、Agent A/B/C 都在同一台 `feedmob2`，加入同一 Compose 网络。Platform 不暴露公网，只映射到宿主机 `127.0.0.1:18788`；三个 Gateway 分别使用 `127.0.0.1:18790`、`:18791`、`:18792`。现有 `openclaw-cf` 的 `:18789` 不动。

## 启动前

1. 用 GitHub Actions 或其他外部 amd64 runner 发布两个镜像（见 [`../github-actions/build.yml`](../github-actions/build.yml)）。服务器不执行 Docker build/npm build。
2. 将本目录复制到服务器专用目录，例如 `/home/ubuntu/openclaw-group-demo`。
3. `cp .env.example .env`，填写三个 Platform Agent id/token 和三个本地 Gateway token。演示版 Platform API 不启用 Admin token；填写后的 `.env` 不得回传仓库或报告。
4. 先生成三份运行配置。它们的模板不含模型密钥；用隐藏输入临时配置模型：

```bash
for agent in agent-a agent-b agent-c; do
  cp "config/$agent/openclaw.json.template" "config/$agent/openclaw.json"
done
read -rsp 'Temporary FeedMob API key: ' FEEDMOB_API_KEY; echo
export FEEDMOB_API_KEY
./configure-model.sh
unset FEEDMOB_API_KEY
```

5. 先只启动 Platform：

```bash
docker compose up -d feedmob-group-platform
curl -fsS http://127.0.0.1:18788/health
```

6. 直接调用管理 API 创建三个 Agent，再把对应 id/token 填入 `.env`。Platform 初始不预置 Agent、角色或群组；Agent 不会自动加入群组。
7. 启动三只 Agent：

```bash
docker compose up -d openclaw-agent-a openclaw-agent-b openclaw-agent-c
```

## 验收

```bash
node ../../tests/smoke-platform.mjs http://127.0.0.1:18788
docker compose ps
docker stats --no-stream
free -h
```

烟测会临时创建测试用户、Agent 和群组，验证一个 Agent 属于两个群组时的隔离、另一个 Agent 不会收到未加入群组的消息，以及按群组 ACK 后的断线 replay。测试 token 只在进程内使用。

## 演练结束清理临时模型

演练和端到端测试完成后，先停三只 Agent，再删除三份运行配置中的 `apiKey`、删除 `.env` 和 Platform 数据目录（若不需要保留烟测数据）。不要把带 `apiKey` 的运行配置复制回仓库。

```bash
docker compose stop openclaw-agent-a openclaw-agent-b openclaw-agent-c
for agent in agent-a agent-b agent-c; do
  jq 'del(.models.providers.feedmob.apiKey)' "config/$agent/openclaw.json" > "config/$agent/openclaw.json.clean"
  mv "config/$agent/openclaw.json.clean" "config/$agent/openclaw.json"
done
rm -f .env
```

## 内存护栏

Compose 对 Platform 设置 `384m` 上限/`256m` 保留，对每只 OpenClaw+Camofox 设置 `768m` 上限/`512m` 保留。启动后必须确认宿主机 `MemAvailable` 仍至少 `500MiB`，目标是 `1GiB`；出现 OOM 或低于门槛时先停 `openclaw-agent-c`，再迁移它，不要停现有 OpenShip 或 `openclaw-cf`。

```bash
docker compose stop openclaw-agent-c
free -h
docker stats --no-stream
```

## 明天拆成两台

保持 Platform 协议和 Agent 配置不变：把 Platform 服务迁到 F3，给它内网地址或正式 HTTPS 域名，然后将三个容器的 `FEEDMOB_GROUP_SERVER_URL` 从 Compose 服务名改成该地址。单机模式不依赖 DNS，正式 HTTPS/反代上线前再做跨机验收；不在今晚临时改现有 Caddy 路由。
