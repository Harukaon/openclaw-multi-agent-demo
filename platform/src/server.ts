import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { Store } from "./store.js";
import { mentionStateFor } from "./mention.js";
import { buildAgentContentForAgent } from "./agent-prompt.js";
import type {
  AgentAck,
  AgentHello,
  AgentMessageEvent,
  AgentOutboundMessage,
  AgentBroadcastContext,
  Group,
  GroupMember,
  MentionState,
  MemberType,
  BroadcastAgentStatus,
  BroadcastStatusEvent,
  Sender,
  StoredMessage,
  UserGroupsUpdatedEvent,
  UserHello,
  UserMessageEvent,
  UserOutboundMessage,
} from "./types.js";

const CHANNEL_ID = "feedmob-group-chat";
const configuredBroadcastAckTimeout = Number(process.env.BROADCAST_ACK_TIMEOUT_MS || 120_000);
const BROADCAST_ACK_TIMEOUT_MS = Number.isFinite(configuredBroadcastAckTimeout) && configuredBroadcastAckTimeout > 0
  ? configuredBroadcastAckTimeout
  : 120_000;
const configuredBroadcastMaxReplies = Number(process.env.BROADCAST_MAX_AGENT_REPLIES || 12);
const BROADCAST_MAX_AGENT_REPLIES = Number.isFinite(configuredBroadcastMaxReplies) && configuredBroadcastMaxReplies > 0
  ? Math.floor(configuredBroadcastMaxReplies)
  : 12;
const configuredBroadcastSettleMs = Number(process.env.BROADCAST_SETTLE_MS || 2_000);
const BROADCAST_SETTLE_MS = Number.isFinite(configuredBroadcastSettleMs) && configuredBroadcastSettleMs >= 0
  ? Math.floor(configuredBroadcastSettleMs)
  : 2_000;

type BroadcastTurn = {
  turnId: string;
  groupId: string;
  rootMessageId: string;
  maxAgentReplies: number;
  agentReplyCount: number;
  pendingDeliveries: number;
  agents: BroadcastStatusEvent["agents"];
  repliedAgents: Set<string>;
  cancelled?: boolean;
  completed?: boolean;
  settleTimer?: ReturnType<typeof setTimeout>;
};

type BroadcastStep = BroadcastTurn & {
  agentId: string;
  messageId: string;
  seq: number;
};

type BroadcastAckResult = "acked" | "timeout" | "offline";

type BroadcastAckWaiter = {
  agentId: string;
  groupId: string;
  messageId: string;
  seq: number;
  resolve: (result: BroadcastAckResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function rawToString(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return raw.toString("utf8");
}

function parseJson(raw: RawData): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawToString(raw));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function errorPayload(code: string, message: string): { type: "error"; code: string; message: string } {
  return { type: "error", code, message };
}

function httpError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { code: "request_error", message } });
}

function parseMemberType(value: unknown): MemberType | undefined {
  return value === "human" || value === "agent" ? value : undefined;
}

export class PlatformServer {
  readonly app = express();
  readonly httpServer: HttpServer;
  readonly agentWss = new WebSocketServer({ noServer: true });
  readonly userWss = new WebSocketServer({ noServer: true });
  readonly agentSockets = new Map<string, WebSocket>();
  readonly userSockets = new Map<string, Set<WebSocket>>();
  readonly store: Store;
  private readonly broadcastTurns = new Map<string, BroadcastTurn>();
  private readonly broadcastDeliveryQueues = new Map<string, Promise<void>>();
  private readonly broadcastDeliveryKeys = new Set<string>();
  private readonly broadcastAckWaiters = new Map<string, BroadcastAckWaiter>();
  private readonly broadcastStatuses = new Map<string, BroadcastStatusEvent>();

  constructor(store = new Store(process.env.DATABASE_FILE || ":memory:")) {
    this.store = store;
    this.httpServer = createServer(this.app);
    this.configureHttp();
    this.configureWebSockets();
  }

  listen(port = Number(process.env.PORT || 8787), host = process.env.HOST || "0.0.0.0"): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.httpServer.off("error", onError);
        resolve();
      };
      this.httpServer.once("error", onError);
      this.httpServer.once("listening", onListening);
      this.httpServer.listen(port, host);
    });
  }

  async stop(): Promise<void> {
    for (const waiter of this.broadcastAckWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve("offline");
    }
    this.broadcastAckWaiters.clear();
    for (const turn of this.broadcastTurns.values()) {
      turn.cancelled = true;
      if (turn.settleTimer) clearTimeout(turn.settleTimer);
    }
    const sockets = new Set<WebSocket>([...this.agentWss.clients, ...this.userWss.clients]);
    await Promise.all([...sockets].map((socket) => this.closeSocket(socket)));
    return new Promise((resolve, reject) => {
      this.httpServer.close((error) => {
        this.store.close();
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private closeSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      socket.once("close", () => resolve());
      socket.close(1001, "server stopping");
    });
  }

  private canUserSeeGroup(req: Request, res: Response, group: Group): boolean {
    const userId = asString(req.get("x-user-id")) || asString(req.query.userId);
    if (!userId || !this.store.getUser(userId) || !this.store.isMember(group.id, "human", userId)) {
      httpError(res, 404, "group not found");
      return false;
    }
    return true;
  }

  private configureHttp(): void {
    this.app.disable("x-powered-by");
    this.app.use(express.json({ limit: "128kb" }));
    this.app.use((_req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "content-type, x-user-id");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      if (_req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
    });
    this.app.get("/health", (_req, res) => {
      res.json({
        ok: true,
        service: CHANNEL_ID,
        onlineAgents: this.store.countOnlineAgents(),
        groups: this.store.countGroups(),
        timestamp: new Date().toISOString(),
      });
    });

    this.app.get("/api/users", (_req, res) => res.json({ users: this.store.listUsers() }));
    this.app.post("/api/login", (req, res) => {
      try {
        const username = asString(req.body?.username);
        if (!username || !/^[\p{L}\p{N}_.-]{1,32}$/u.test(username)) {
          return httpError(res, 400, "username must be 1-32 letters, numbers, dot, underscore or hyphen");
        }
        const user = this.store.getUserByUsername(username) || this.store.createUser({ username, displayName: username });
        return res.json({ user });
      } catch (error) {
        return httpError(res, 409, error instanceof Error ? error.message : "login failed");
      }
    });
    this.app.post("/api/users", (req, res) => {
      try {
        const username = asString(req.body?.username);
        const displayName = asString(req.body?.displayName);
        if (!username || !displayName) return httpError(res, 400, "username and displayName are required");
        return res.status(201).json({ user: this.store.createUser({ username, displayName }) });
      } catch (error) {
        return httpError(res, 409, error instanceof Error ? error.message : "user creation failed");
      }
    });

    this.app.get("/api/agents", (_req, res) => res.json({ agents: this.store.listAgents() }));
    this.app.post("/api/agents", (req, res) => {
      try {
        const displayName = asString(req.body?.displayName);
        if (!displayName) return httpError(res, 400, "displayName is required");
        const created = this.store.createAgent({
          id: asString(req.body?.id),
          displayName,
          description: asString(req.body?.description),
          avatar: asString(req.body?.avatar),
        });
        // The token is returned only at creation time. Do not log or persist it in reports.
        return res.status(201).json(created);
      } catch (error) {
        return httpError(res, 409, error instanceof Error ? error.message : "agent creation failed");
      }
    });
    this.app.get("/api/agents/:agentId/state", (req, res) => {
      const agent = this.store.getAgent(req.params.agentId);
      if (!agent) return httpError(res, 404, "agent not found");
      return res.json({ agent, groups: this.store.listGroupsForAgent(agent.id), states: this.store.getAgentGroupStates(agent.id) });
    });

    this.app.post("/api/groups", (req, res) => {
      try {
        const name = asString(req.body?.name);
        const ownerId = asString(req.body?.ownerId);
        if (!name || !ownerId) return httpError(res, 400, "name and ownerId are required");
        if (!this.store.getUser(ownerId)) return httpError(res, 404, "owner user not found");
        const group = this.store.createGroup({ id: asString(req.body?.id), name, ownerId });
        this.publishGroupsUpdated([ownerId]);
        return res.status(201).json({ group });
      } catch (error) {
        return httpError(res, 409, error instanceof Error ? error.message : "group creation failed");
      }
    });
    this.app.get("/api/groups", (req, res) => {
      const userId = asString(req.get("x-user-id")) || asString(req.query.userId);
      if (!userId) return httpError(res, 400, "userId is required");
      if (!this.store.getUser(userId)) return httpError(res, 404, "user not found");
      return res.json({ groups: this.store.listGroupsForUser(userId) });
    });
    this.app.get("/api/groups/:groupId", (req, res) => {
      const group = this.store.getGroup(req.params.groupId);
      if (!group) return httpError(res, 404, "group not found");
      if (!this.canUserSeeGroup(req, res, group)) return;
      return res.json({ group, members: this.store.getGroupMembers(group.id) });
    });
    this.app.get("/api/groups/:groupId/messages", (req, res) => {
      const group = this.store.getGroup(req.params.groupId);
      if (!group) return httpError(res, 404, "group not found");
      if (!this.canUserSeeGroup(req, res, group)) return;
      const afterSeq = Number(req.query.afterSeq || 0);
      return res.json({ messages: this.store.getMessages(group.id, Number.isFinite(afterSeq) ? afterSeq : 0) });
    });

    this.app.post("/api/groups/:groupId/members", (req, res) => {
      const group = this.store.getGroup(req.params.groupId);
      const actorId = asString(req.body?.actorId);
      const memberType = parseMemberType(req.body?.memberType);
      const memberId = asString(req.body?.memberId);
      if (!group) return httpError(res, 404, "group not found");
      if (!actorId || actorId !== group.ownerId) return httpError(res, 403, "only the group owner may change membership");
      if (!memberType || !memberId) return httpError(res, 400, "memberType and memberId are required");
      if (memberType === "human" && !this.store.getUser(memberId)) return httpError(res, 404, "user not found");
      if (memberType === "agent" && !this.store.getAgent(memberId)) return httpError(res, 404, "agent not found");
      this.store.addMember({ groupId: group.id, memberType, memberId });
      this.publishGroupsUpdated([group.ownerId, ...(memberType === "human" ? [memberId] : [])]);
      return res.status(201).json({ members: this.store.getGroupMembers(group.id) });
    });
    this.app.delete("/api/groups/:groupId/members/:memberType/:memberId", (req, res) => {
      const group = this.store.getGroup(req.params.groupId);
      const actorId = asString(req.query.actorId);
      const memberType = parseMemberType(req.params.memberType);
      if (!group) return httpError(res, 404, "group not found");
      if (!actorId || actorId !== group.ownerId) return httpError(res, 403, "only the group owner may change membership");
      if (!memberType) return httpError(res, 400, "invalid memberType");
      this.store.removeMember(group.id, memberType, req.params.memberId);
      this.publishGroupsUpdated([group.ownerId, ...(memberType === "human" ? [req.params.memberId] : [])]);
      return res.status(204).end();
    });

    this.app.post("/api/groups/:groupId/messages", (req, res) => {
      try {
        const group = this.store.getGroup(req.params.groupId);
        const senderType = parseMemberType(req.body?.senderType);
        const senderId = asString(req.body?.senderId);
        const content = asString(req.body?.content);
        if (!group) return httpError(res, 404, "group not found");
        if (group.status === "paused") return httpError(res, 409, "group is paused");
        if (!senderType || !senderId || !content) return httpError(res, 400, "senderType, senderId and content are required");
        if (!this.store.isMember(group.id, senderType, senderId)) return httpError(res, 403, "sender is not a group member");
        const sender = this.resolveSender(senderType, senderId);
        if (!sender) return httpError(res, 404, "sender not found");
        const message = this.appendAndBroadcast({
          groupId: group.id,
          sender,
          content,
          parentMessageId: asString(req.body?.parentMessageId),
          rootMessageId: asString(req.body?.rootMessageId),
        });
        if (sender.type === "human") this.startBroadcast(group, message);
        return res.status(201).json({ message });
      } catch (error) {
        return httpError(res, 409, error instanceof Error ? error.message : "message rejected");
      }
    });

    this.app.post("/api/groups/:groupId/pause", (req, res) => {
      const group = this.store.getGroup(req.params.groupId);
      const actorId = asString(req.body?.actorId);
      if (!group) return httpError(res, 404, "group not found");
      if (actorId !== group.ownerId) return httpError(res, 403, "only the group owner may pause a group");
      const paused = req.body?.paused !== false;
      this.store.setGroupStatus(group.id, paused ? "paused" : "active");
      if (paused) this.resetBroadcastGroup(group.id);
      return res.json({ group: this.store.getGroup(group.id) });
    });
    this.app.post("/api/groups/:groupId/reset", (req, res) => {
      const group = this.store.getGroup(req.params.groupId);
      const actorId = asString(req.body?.actorId);
      if (!group) return httpError(res, 404, "group not found");
      if (actorId !== group.ownerId) return httpError(res, 403, "only the group owner may reset a group");
      this.store.resetGroup(group.id);
      this.resetBroadcastGroup(group.id);
      return res.json({ ok: true, groupId: group.id });
    });

    this.app.use((_req, res) => httpError(res, 404, "not found"));
  }

  private configureWebSockets(): void {
    this.httpServer.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url || "/", "http://localhost").pathname;
      if (pathname === "/ws/agent") {
        this.agentWss.handleUpgrade(request, socket, head, (client) => this.agentWss.emit("connection", client, request));
        return;
      }
      if (pathname === "/ws/user") {
        this.userWss.handleUpgrade(request, socket, head, (client) => this.userWss.emit("connection", client, request));
        return;
      }
      socket.destroy();
    });

    this.agentWss.on("connection", (socket: WebSocket) => {
      let agentId: string | undefined;
      socket.on("message", (raw) => {
        void this.handleAgentSocketMessage(socket, parseJson(raw), (id) => {
          agentId = id;
        });
      });
      socket.on("close", () => {
        if (agentId && this.agentSockets.get(agentId) === socket) {
          this.agentSockets.delete(agentId);
          this.store.setAgentConnection(agentId, false);
          this.resolveBroadcastWaitersForAgent(agentId);
        }
      });
      socket.on("error", () => undefined);
    });

    this.userWss.on("connection", (socket: WebSocket) => {
      let userId: string | undefined;
      socket.on("message", (raw) => {
        void this.handleUserSocketMessage(socket, parseJson(raw), (id) => {
          userId = id;
        });
      });
      socket.on("close", () => {
        if (!userId) return;
        const sockets = this.userSockets.get(userId);
        sockets?.delete(socket);
        if (sockets?.size === 0) this.userSockets.delete(userId);
      });
      socket.on("error", () => undefined);
    });
  }

  private async handleAgentSocketMessage(
    socket: WebSocket,
    message: Record<string, unknown> | null,
    setAgentId: (agentId: string) => void,
  ): Promise<void> {
    if (!message) return sendJson(socket, errorPayload("invalid_json", "message must be a JSON object"));
    if (message.type === "hello") {
      const hello: AgentHello = {
        type: "hello",
        agentId: asString(message.agentId) || "",
        token: asString(message.token) || "",
      };
      const agent = this.store.authenticateAgent(hello.agentId, hello.token);
      if (!agent) {
        sendJson(socket, errorPayload("unauthorized", "invalid agent credentials"));
        socket.close(4003, "unauthorized");
        return;
      }
      const previous = this.agentSockets.get(agent.id);
      if (previous && previous !== socket) previous.close(4001, "replaced by a newer connection");
      this.agentSockets.set(agent.id, socket);
      setAgentId(agent.id);
      this.store.setAgentConnection(agent.id, true);
      const groups = this.store.listGroupsForAgent(agent.id);
      sendJson(socket, { type: "hello.ok", channel: CHANNEL_ID, agent, groups });
      for (const group of groups) {
        const afterSeq = this.store.getAgentAck(agent.id, group.id);
        for (const messageToReplay of this.store.getMessages(group.id, afterSeq)) {
          this.sendMessageToAgent(agent.id, messageToReplay);
        }
        sendJson(socket, { type: "replay.end", groupId: group.id, lastSeq: this.latestSeq(group.id) });
      }
      return;
    }

    const agentId = this.findAgentForSocket(socket);
    if (!agentId) return sendJson(socket, errorPayload("hello_required", "send hello first"));
    if (message.type === "ack") {
      const ack: AgentAck = {
        type: "ack",
        groupId: asString(message.groupId) || "",
        messageId: asString(message.messageId),
        seq: Number(message.seq),
      };
      if (
        !ack.groupId ||
        !Number.isSafeInteger(ack.seq) ||
        ack.seq < 0 ||
        ack.seq > this.store.latestSeq(ack.groupId) ||
        !this.store.isMember(ack.groupId, "agent", agentId)
      ) {
        return sendJson(socket, errorPayload("invalid_ack", "invalid group membership or sequence"));
      }
      this.store.ack({ agentId, groupId: ack.groupId, seq: ack.seq, messageId: ack.messageId });
      this.resolveBroadcastAck(agentId, ack.groupId, ack.messageId, ack.seq);
      return;
    }
    if (message.type === "agent.message") {
      const outbound: AgentOutboundMessage = {
        type: "agent.message",
        clientMessageId: asString(message.clientMessageId),
        groupId: asString(message.groupId) || "",
        content: asString(message.content) || "",
        parentMessageId: asString(message.parentMessageId),
        rootMessageId: asString(message.rootMessageId),
        depth: Number.isSafeInteger(Number(message.depth)) ? Number(message.depth) : undefined,
      };
      const group = this.store.getGroup(outbound.groupId);
      if (!group || group.status === "paused") return sendJson(socket, errorPayload("group_unavailable", "group is missing or paused"));
      if (!outbound.content || !this.store.isMember(group.id, "agent", agentId)) {
        return sendJson(socket, errorPayload("not_group_member", "agent is not a member of this group"));
      }
      const agent = this.store.getAgent(agentId);
      if (!agent) return sendJson(socket, errorPayload("agent_not_found", "agent not found"));
      const rootMessageId = outbound.rootMessageId || outbound.parentMessageId;
      const turn = rootMessageId ? this.broadcastTurns.get(rootMessageId) : undefined;
      if (turn && (turn.completed || turn.agentReplyCount >= turn.maxAgentReplies)) {
        if (!turn.completed) {
          this.setBroadcastAgentStatus(turn, agentId, "limit");
          this.publishBroadcastStatus(group, turn);
        }
        sendJson(socket, {
          type: "message.suppressed",
          clientMessageId: outbound.clientMessageId,
          groupId: group.id,
          reason: turn.completed ? "turn_completed" : "max_agent_replies",
        });
        return;
      }
      const created = this.appendAndBroadcast({
        groupId: group.id,
        sender: { type: "agent", id: agent.id, name: agent.displayName },
        content: outbound.content,
        parentMessageId: outbound.parentMessageId,
        rootMessageId: rootMessageId,
        depth: outbound.depth,
      });
      sendJson(socket, {
        type: "message.accepted",
        clientMessageId: outbound.clientMessageId,
        groupId: group.id,
        messageId: created.id,
        seq: created.seq,
      });
      return;
    }
    if (message.type === "ping") return sendJson(socket, { type: "pong", timestamp: Date.now() });
    sendJson(socket, errorPayload("unknown_type", "unsupported agent message type"));
  }

  private async handleUserSocketMessage(
    socket: WebSocket,
    message: Record<string, unknown> | null,
    setUserId: (userId: string) => void,
  ): Promise<void> {
    if (!message) return sendJson(socket, errorPayload("invalid_json", "message must be a JSON object"));
    if (message.type === "hello") {
      const hello: UserHello = { type: "hello", userId: asString(message.userId) || "" };
      if (!this.store.getUser(hello.userId)) {
        sendJson(socket, errorPayload("unauthorized", "unknown user"));
        socket.close(4003, "unauthorized");
        return;
      }
      setUserId(hello.userId);
      const sockets = this.userSockets.get(hello.userId) || new Set<WebSocket>();
      sockets.add(socket);
      this.userSockets.set(hello.userId, sockets);
      const groups = this.store.listGroupsForUser(hello.userId);
      sendJson(socket, {
        type: "hello.ok",
        channel: CHANNEL_ID,
        groups,
        broadcastStatuses: groups
          .map((group) => this.broadcastStatuses.get(group.id))
          .filter((status): status is BroadcastStatusEvent => Boolean(status)),
      });
      return;
    }
    const userId = this.findUserForSocket(socket);
    if (!userId) return sendJson(socket, errorPayload("hello_required", "send hello first"));
    if (message.type === "user.message") {
      const outbound: UserOutboundMessage = {
        type: "user.message",
        groupId: asString(message.groupId) || "",
        content: asString(message.content) || "",
        parentMessageId: asString(message.parentMessageId),
        rootMessageId: asString(message.rootMessageId),
      };
      const group = this.store.getGroup(outbound.groupId);
      if (!group || group.status === "paused") return sendJson(socket, errorPayload("group_unavailable", "group is missing or paused"));
      if (!outbound.content || !this.store.isMember(group.id, "human", userId)) {
        return sendJson(socket, errorPayload("not_group_member", "user is not a member of this group"));
      }
      const user = this.store.getUser(userId);
      if (!user) return sendJson(socket, errorPayload("user_not_found", "user not found"));
      const createdMessage = this.appendAndBroadcast({
        groupId: group.id,
        sender: { type: "human", id: user.id, name: user.displayName },
        content: outbound.content,
        parentMessageId: outbound.parentMessageId,
        rootMessageId: outbound.rootMessageId,
      });
      this.startBroadcast(group, createdMessage);
      return;
    }
    if (message.type === "ping") return sendJson(socket, { type: "pong", timestamp: Date.now() });
    sendJson(socket, errorPayload("unknown_type", "unsupported user message type"));
  }

  private appendAndBroadcast(input: {
    groupId: string;
    sender: Sender;
    content: string;
    parentMessageId?: string;
    rootMessageId?: string;
    depth?: number;
  }): StoredMessage {
    const message = this.store.appendMessage(input);
    const group = this.store.getGroup(input.groupId);
    if (!group) throw new Error("group not found after message append");
    this.broadcastMessage(group, message);
    if (message.sender.type === "agent") this.broadcastAgentMessage(group, message);
    return message;
  }

  private publishGroupsUpdated(userIds: Iterable<string>): void {
    for (const userId of new Set(userIds)) {
      const sockets = this.userSockets.get(userId);
      if (!sockets) continue;
      const groups = this.store.listGroupsForUser(userId);
      const event: UserGroupsUpdatedEvent = { type: "groups.updated", groups };
      for (const socket of sockets) sendJson(socket, event);
    }
  }

  private broadcastMessage(group: Group, message: StoredMessage): void {
    const members = this.store.getGroupMembers(group.id);
    const humanEvent: UserMessageEvent = {
      type: "message",
      group: { id: group.id, name: group.name },
      seq: message.seq,
      messageId: message.id,
      sender: message.sender,
      content: message.content,
      mentions: message.mentions,
      parentMessageId: message.parentMessageId,
      rootMessageId: message.rootMessageId,
      depth: message.depth,
      createdAt: message.createdAt,
    };
    for (const member of members.filter((item) => item.memberType === "human")) {
      const sockets = this.userSockets.get(member.memberId);
      if (!sockets) continue;
      for (const socket of sockets) sendJson(socket, humanEvent);
    }
  }

  private startBroadcast(group: Group, rootMessage: StoredMessage): void {
    const turn = this.getOrCreateBroadcastTurn(group, rootMessage.rootMessageId || rootMessage.id);
    if (turn.settleTimer) {
      clearTimeout(turn.settleTimer);
      turn.settleTimer = undefined;
    }
    for (const member of this.store.getGroupMembers(group.id).filter((item) => item.memberType === "agent")) {
      this.queueBroadcastDelivery(turn, group, member, rootMessage);
    }
    this.publishBroadcastStatus(group, turn);
    this.maybeSettleBroadcast(turn);
  }

  private getOrCreateBroadcastTurn(group: Group, rootMessageId: string): BroadcastTurn {
    const existing = this.broadcastTurns.get(rootMessageId);
    if (existing) return existing;
    const turn: BroadcastTurn = {
      turnId: randomUUID(),
      groupId: group.id,
      rootMessageId,
      maxAgentReplies: BROADCAST_MAX_AGENT_REPLIES,
      agentReplyCount: 0,
      pendingDeliveries: 0,
      repliedAgents: new Set<string>(),
      agents: this.store.getGroupMembers(group.id)
        .filter((member) => member.memberType === "agent")
        .map((member) => ({ id: member.memberId, displayName: member.displayName, status: "waiting" as BroadcastAgentStatus })),
    };
    this.broadcastTurns.set(rootMessageId, turn);
    return turn;
  }

  private queueBroadcastDelivery(turn: BroadcastTurn, group: Group, member: GroupMember, message: StoredMessage): void {
    if (turn.cancelled || (message.sender.type === "agent" && message.sender.id === member.memberId)) {
      this.store.markDeliveryResult(message.id, group.id, member.memberId, "skipped");
      return;
    }
    const deliveryKey = `${turn.turnId}:${message.id}:${member.memberId}`;
    if (this.broadcastDeliveryKeys.has(deliveryKey)) return;
    this.broadcastDeliveryKeys.add(deliveryKey);
    this.ensureBroadcastAgent(turn, member);
    this.setBroadcastAgentStatus(turn, member.memberId, "waiting");
    turn.pendingDeliveries += 1;
    const queueKey = `${group.id}:${member.memberId}`;
    const previous = this.broadcastDeliveryQueues.get(queueKey) || Promise.resolve();
    const next = previous
      .then(() => this.deliverBroadcastMessage(turn, group, member, message))
      .catch((error: unknown) => {
        console.error(`[${CHANNEL_ID}] broadcast delivery failed group=${group.id} agent=${member.memberId}: ${String(error)}`);
        this.setBroadcastAgentStatus(turn, member.memberId, "offline");
      })
      .finally(() => {
        turn.pendingDeliveries = Math.max(0, turn.pendingDeliveries - 1);
        if (this.broadcastDeliveryQueues.get(queueKey) === next) this.broadcastDeliveryQueues.delete(queueKey);
        this.maybeSettleBroadcast(turn);
      });
    this.broadcastDeliveryQueues.set(queueKey, next);
  }

  private async deliverBroadcastMessage(turn: BroadcastTurn, group: Group, member: GroupMember, message: StoredMessage): Promise<void> {
    if (turn.cancelled) return;
    const socket = this.agentSockets.get(member.memberId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.store.markDeliveryResult(message.id, group.id, member.memberId, "offline");
      this.setBroadcastAgentStatus(turn, member.memberId, "offline");
      return;
    }
    // Keep turn control isolated by rootMessageId, but give the Agent the full
    // group history so it can recognize prior replies across human turns.
    const conversation = this.store.getMessages(group.id)
      .filter((item) => item.seq <= message.seq);
    const step: BroadcastStep = {
      ...turn,
      agentId: member.memberId,
      messageId: message.id,
      seq: message.seq,
    };
    this.setBroadcastAgentStatus(turn, member.memberId, "replying");
    this.publishBroadcastStatus(group, turn);
    const ackResultPromise = this.waitForBroadcastAck(step);
    this.sendBroadcastStep(socket, member, group, message, step, conversation);
    const ackResult = await ackResultPromise;
    if (turn.cancelled) return;
    const hasVisibleReply = this.store.hasAgentReplyTo(message.id, group.id, member.memberId);
    if (ackResult === "timeout") {
      this.store.markDeliveryResult(message.id, group.id, member.memberId, "timeout");
      this.setBroadcastAgentStatus(turn, member.memberId, "timeout");
    } else if (ackResult === "offline") {
      this.store.markDeliveryResult(message.id, group.id, member.memberId, "offline");
      this.setBroadcastAgentStatus(turn, member.memberId, "offline");
    } else {
      this.store.markDeliveryResult(message.id, group.id, member.memberId, "acked");
      if (hasVisibleReply) turn.repliedAgents.add(member.memberId);
      this.setBroadcastAgentStatus(turn, member.memberId, hasVisibleReply || turn.repliedAgents.has(member.memberId) ? "replied" : "no_reply");
    }
    this.publishBroadcastStatus(group, turn);
  }

  private sendBroadcastStep(
    socket: WebSocket,
    member: GroupMember,
    group: Group,
    message: StoredMessage,
    step: BroadcastStep,
    conversation: readonly StoredMessage[],
  ): void {
    const broadcast: AgentBroadcastContext = {
      turnId: step.turnId,
      rootMessageId: step.rootMessageId,
      depth: message.depth,
      agentReplyCount: step.agentReplyCount,
      maxAgentReplies: step.maxAgentReplies,
    };
    sendJson(socket, this.buildAgentEvent(member, group, message, {
      broadcast,
      conversation,
      mentionState: mentionStateFor(message.sender.type, message.sender.id, member.memberId, message.mentions),
    }));
    this.store.markDelivered(message.id, group.id, member.memberId);
  }

  private ensureBroadcastAgent(turn: BroadcastTurn, member: GroupMember): void {
    if (turn.agents.some((agent) => agent.id === member.memberId)) return;
    turn.agents.push({ id: member.memberId, displayName: member.displayName, status: "waiting" });
  }

  private setBroadcastAgentStatus(turn: BroadcastTurn, agentId: string, status: BroadcastAgentStatus): void {
    const entry = turn.agents.find((agent) => agent.id === agentId);
    if (entry) entry.status = status;
  }

  private broadcastAgentMessage(group: Group, message: StoredMessage): void {
    const turn = this.getOrCreateBroadcastTurn(group, message.rootMessageId || message.id);
    if (turn.settleTimer) {
      clearTimeout(turn.settleTimer);
      turn.settleTimer = undefined;
    }
    turn.agentReplyCount += 1;
    turn.repliedAgents.add(message.sender.id);
    this.ensureBroadcastAgent(turn, {
      groupId: group.id,
      memberType: "agent",
      memberId: message.sender.id,
      role: "member",
      displayName: message.sender.name,
      joinedAt: message.createdAt,
    });
    this.setBroadcastAgentStatus(turn, message.sender.id, "replied");
    // Keep turn control isolated by rootMessageId, but give the Agent the full
    // group history so it can recognize prior replies across human turns.
    const conversation = this.store.getMessages(group.id)
      .filter((item) => item.seq <= message.seq);
    for (const member of this.store.getGroupMembers(group.id).filter((item) => item.memberType === "agent")) {
      if (message.sender.id === member.memberId) {
        this.store.markDeliveryResult(message.id, group.id, member.memberId, "skipped");
        continue;
      }
      const directlyMentioned = message.mentions.some((mention) => mention.type === "agent" && mention.id === member.memberId);
      if (directlyMentioned) this.queueBroadcastDelivery(turn, group, member, message);
      else this.sendBroadcastObservation(turn, group, member, message, conversation);
    }
    this.publishBroadcastStatus(group, turn);
    this.maybeSettleBroadcast(turn);
  }

  private sendBroadcastObservation(
    turn: BroadcastTurn,
    group: Group,
    member: GroupMember,
    message: StoredMessage,
    conversation: readonly StoredMessage[],
  ): void {
    const socket = this.agentSockets.get(member.memberId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const broadcast: AgentBroadcastContext = {
      turnId: turn.turnId,
      rootMessageId: turn.rootMessageId,
      depth: message.depth,
      agentReplyCount: turn.agentReplyCount,
      maxAgentReplies: turn.maxAgentReplies,
    };
    // Every Agent can observe the complete turn, but only a direct @ mention
    // starts an OpenClaw turn. This prevents weak models from echoing forever.
    sendJson(socket, this.buildAgentEvent(member, group, message, { broadcast, conversation, observation: true }));
    this.store.markDelivered(message.id, group.id, member.memberId);
  }

  private sendMessageToAgent(agentId: string, message: StoredMessage): void {
    const group = this.store.getGroup(message.groupId);
    const member = this.store.getGroupMembers(message.groupId).find((item) => item.memberType === "agent" && item.memberId === agentId);
    const socket = this.agentSockets.get(agentId);
    if (!group || !member || !socket) return;
    // Replays are observations only. The plugin ACKs them without starting a new turn.
    sendJson(socket, this.buildAgentEvent(member, group, message));
    this.store.markDelivered(message.id, group.id, agentId);
  }

  private buildAgentEvent(
    member: GroupMember,
    group: Group,
    message: StoredMessage,
    options: { broadcast?: AgentBroadcastContext; conversation?: readonly StoredMessage[]; mentionState?: MentionState; observation?: boolean } = {},
  ): AgentMessageEvent {
    const mentionState = options.mentionState ?? mentionStateFor(message.sender.type, message.sender.id, member.memberId, message.mentions);
    return {
      type: "message",
      group: { id: group.id, name: group.name },
      seq: message.seq,
      messageId: message.id,
      sender: message.sender,
      content: message.content,
      contentForAgent: buildAgentContentForAgent({
        agent: { id: member.memberId, displayName: member.displayName },
        group,
        sender: message.sender,
        content: message.content,
        mentionState,
        broadcast: options.broadcast,
        conversation: options.conversation,
        observation: options.observation,
      }),
      mentions: message.mentions,
      parentMessageId: message.parentMessageId,
      rootMessageId: message.rootMessageId,
      depth: message.depth,
      createdAt: message.createdAt,
      deliveryContext: {
        groupId: group.id,
        groupName: group.name,
        mentionState,
        selfMessage: mentionState === "SELF",
        broadcast: options.broadcast,
        observation: options.observation,
      },
    };
  }

  private broadcastStatusFor(turn: BroadcastTurn): BroadcastStatusEvent {
    return {
      type: "broadcast.status",
      group: { id: turn.groupId, name: this.store.getGroup(turn.groupId)?.name || turn.groupId },
      turnId: turn.turnId,
      rootMessageId: turn.rootMessageId,
      state: "broadcasting",
      activeAgents: turn.agents
        .filter((agent) => agent.status === "waiting" || agent.status === "replying")
        .map(({ id, displayName }) => ({ id, displayName })),
      agentReplyCount: turn.agentReplyCount,
      maxAgentReplies: turn.maxAgentReplies,
      agents: turn.agents,
      updatedAt: new Date().toISOString(),
    };
  }

  private publishBroadcastStatus(group: Group, turn: BroadcastTurn): void {
    const status = this.broadcastStatusFor(turn);
    this.broadcastStatuses.set(group.id, status);
    const humanMembers = this.store.getGroupMembers(group.id).filter((member) => member.memberType === "human");
    for (const member of humanMembers) {
      const sockets = this.userSockets.get(member.memberId);
      if (!sockets) continue;
      for (const socket of sockets) sendJson(socket, status);
    }
  }

  private maybeSettleBroadcast(turn: BroadcastTurn): void {
    if (turn.cancelled || turn.pendingDeliveries > 0 || turn.settleTimer) return;
    turn.settleTimer = setTimeout(() => {
      turn.settleTimer = undefined;
      if (turn.cancelled || turn.pendingDeliveries > 0) return;
      turn.completed = true;
      for (const agent of turn.agents) {
        if (agent.status === "waiting" || agent.status === "replying" || agent.status === "no_reply") {
          agent.status = turn.repliedAgents.has(agent.id) ? "replied" : "no_reply";
        }
      }
      const group = this.store.getGroup(turn.groupId);
      if (!group) return;
      const status: BroadcastStatusEvent = {
        ...this.broadcastStatusFor(turn),
        state: "completed",
      };
      this.broadcastStatuses.set(group.id, status);
      const humanMembers = this.store.getGroupMembers(group.id).filter((member) => member.memberType === "human");
      for (const member of humanMembers) {
        const sockets = this.userSockets.get(member.memberId);
        if (!sockets) continue;
        for (const socket of sockets) sendJson(socket, status);
      }
    }, BROADCAST_SETTLE_MS);
  }

  private waitForBroadcastAck(step: BroadcastStep): Promise<BroadcastAckResult> {
    const key = this.broadcastAckKey(step.agentId, step.groupId, step.messageId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.broadcastAckWaiters.delete(key);
        resolve("timeout");
      }, BROADCAST_ACK_TIMEOUT_MS);
      this.broadcastAckWaiters.set(key, {
        agentId: step.agentId,
        groupId: step.groupId,
        messageId: step.messageId,
        seq: step.seq,
        resolve,
        timer,
      });
    });
  }

  private resolveBroadcastAck(agentId: string, groupId: string, messageId: string | undefined, seq: number): void {
    for (const [key, waiter] of this.broadcastAckWaiters) {
      if (waiter.agentId !== agentId || waiter.groupId !== groupId) continue;
      if (messageId ? waiter.messageId !== messageId : waiter.seq > seq) continue;
      clearTimeout(waiter.timer);
      this.broadcastAckWaiters.delete(key);
      waiter.resolve("acked");
    }
  }

  private resolveBroadcastWaitersForAgent(agentId: string): void {
    for (const [key, waiter] of this.broadcastAckWaiters) {
      if (waiter.agentId !== agentId) continue;
      clearTimeout(waiter.timer);
      this.broadcastAckWaiters.delete(key);
      waiter.resolve("offline");
    }
  }

  private broadcastAckKey(agentId: string, groupId: string, messageId: string): string {
    return `${agentId}:${groupId}:${messageId}`;
  }

  private resetBroadcastGroup(groupId: string): void {
    for (const [rootMessageId, turn] of this.broadcastTurns) {
      if (turn.groupId !== groupId) continue;
      turn.cancelled = true;
      if (turn.settleTimer) clearTimeout(turn.settleTimer);
      this.broadcastTurns.delete(rootMessageId);
    }
    for (const [key, waiter] of this.broadcastAckWaiters) {
      if (waiter.groupId !== groupId) continue;
      clearTimeout(waiter.timer);
      this.broadcastAckWaiters.delete(key);
      waiter.resolve("offline");
    }
    this.broadcastStatuses.delete(groupId);
  }

  private resolveSender(type: MemberType, id: string): Sender | null {
    if (type === "human") {
      const user = this.store.getUser(id);
      return user ? { type, id: user.id, name: user.displayName } : null;
    }
    const agent = this.store.getAgent(id);
    return agent ? { type, id: agent.id, name: agent.displayName } : null;
  }

  private latestSeq(groupId: string): number {
    return this.store.latestSeq(groupId);
  }

  private findAgentForSocket(socket: WebSocket): string | undefined {
    for (const [agentId, candidate] of this.agentSockets) if (candidate === socket) return agentId;
    return undefined;
  }

  private findUserForSocket(socket: WebSocket): string | undefined {
    for (const [userId, sockets] of this.userSockets) if (sockets.has(socket)) return userId;
    return undefined;
  }
}

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const server = new PlatformServer();
  const port = Number(process.env.PORT || 8787);
  void server.listen(port).then(() => {
    console.log(`feedmob-group-platform listening on ${process.env.HOST || "0.0.0.0"}:${port}`);
  });
  const shutdown = () => {
    void server.stop().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
