# 跨主机公网验收部署

此部署将 Platform 与 Agent A 放在 `feedmob2`，Agent B/C 放在 `feedmob3`。两台服务器各自运行独立 Caddy；F3 的 OpenShip 容器在部署前停止，但不删除 OpenShip 数据。

```text
Cloudflare DNS
   ├─ groupchat / web / agent-a -> F2 Caddy -> F2 Platform / web / Agent A
   └─ agent-b / agent-c         -> F3 Caddy -> F3 Agent B / Agent C
```

## DNS records

```text
groupchat-test.feedmob.it.com      -> 18.216.230.245
groupchat-web-test.feedmob.it.com  -> 18.216.230.245
agent-a-test.feedmob.it.com        -> 18.216.230.245
agent-b-test.feedmob.it.com        -> 13.58.220.167
agent-c-test.feedmob.it.com        -> 13.58.220.167
```

Cloudflare 代理开启橙云，SSL/TLS 模式使用 `Full (strict)`。两台 Caddy 负责源站 HTTPS 和 WebSocket upgrade。

## 服务器目录

- F2 Platform: `/home/ubuntu/feedmob-group-platform`
- F2 Agent A: `/home/ubuntu/feedmob-group-f2`
- F3 Agent B/C: `/home/ubuntu/feedmob-group-f3`
- F3 Caddy: `/home/ubuntu/feedmob-group-f3-caddy`
- F2 Caddy snippet: `/etc/caddy/sites/feedmob-group-test.caddy`
- F2 static web: `/var/www/feedmob-group-chat`

服务器只拉取 GitHub Actions 发布的 amd64 镜像，不 build、不 npm install、不编译。
