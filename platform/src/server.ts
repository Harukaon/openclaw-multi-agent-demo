import express, { type Response } from "express";
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
  AgentPipelineContext,
  Group,
  GroupMember,
  MentionState,
  MemberType,
  PipelineAgentStatus,
  PipelineStatusEvent,
  Sender,
  StoredMessage,
  UserHello,
  UserMessageEvent,
  UserOutboundMessage,
} from "./types.js";

const CHANNEL_ID = "feedmob-group-chat";
const configuredPipelineAckTimeout = Number(process.env.PIPELINE_ACK_TIMEOUT_MS || 120_000);
const PIPELINE_ACK_TIMEOUT_MS = Number.isFinite(configuredPipelineAckTimeout) && configuredPipelineAckTimeout > 0
  ? configuredPipelineAckTimeout
  : 120_000;

type PipelineTurn = {
  turnId: string;
  groupId: string;
  rootMessageId: string;
};

type PipelineStep = PipelineTurn & {
  agentId: string;
  messageId: string;
  step: number;
  totalSteps: number;
};

type PipelineAckResult = "acked" | "timeout" | "offline";

type PipelineAckWaiter = {
  agentId: string;
  groupId: string;
  messageId: string;
  seq: number;
  resolve: (result: PipelineAckResult) => void;
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

function pipelineMentionState(agentId: string, conversation: readonly StoredMessage[]): MentionState {
  const latest = conversation.at(-1);
  if (latest?.sender.type === "agent" && latest.sender.id === agentId) return "SELF";
  if (conversation.some((message) => message.mentions.some((mention) => mention.type === "agent" && mention.id === agentId))) {
    return "DIRECT";
  }
  return conversation.some((message) => message.mentions.length > 0) ? "OTHER" : "NONE";
}

export class PlatformServer {
  readonly app = express();
  readonly httpServer: HttpServer;
  readonly agentWss = new WebSocketServer({ noServer: true });
  readonly userWss = new WebSocketServer({ noServer: true });
  readonly agentSockets = new Map<string, WebSocket>();
  readonly userSockets = new Map<string, Set<WebSocket>>();
  readonly store: Store;
  private readonly pipelineQueues = new Map<string, Promise<void>>();
  private readonly activePipelineSteps = new Map<string, PipelineStep>();
  private readonly pipelineAckWaiters = new Map<string, PipelineAckWaiter>();
  private readonly pipelineStatuses = new Map<string, PipelineStatusEvent>();

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
    for (const waiter of this.pipelineAckWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve("offline");
    }
    this.pipelineAckWaiters.clear();
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
        return res.status(201).json({ group: this.store.createGroup({ id: asString(req.body?.id), name, ownerId }) });
      } catch (error) {
        return httpError(res, 409, error instanceof Error ? error.message : "group creation failed");
      }
    });
    this.app.get("/api/groups", (req, res) => {
      const userId = asString(req.query.userId);
      if (!userId) return httpError(res, 400, "userId is required");
      if (!this.store.getUser(userId)) return httpError(res, 404, "user not found");
      return res.json({ groups: this.store.listGroupsForUser(userId) });
    });
    this.app.get("/api/groups/:groupId", (req, res) => {
      const group = this.store.getGroup(req.params.groupId);
      if (!group) return httpError(res, 404, "group not found");
      return res.json({ group, members: this.store.getGroupMembers(group.id) });
    });
    this.app.get("/api/groups/:groupId/messages", (req, res) => {
      const group = this.store.getGroup(req.params.groupId);
      if (!group) return httpError(res, 404, "group not found");
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
        if (sender.type === "human") this.enqueuePipeline(group, message);
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
      return res.json({ group: this.store.getGroup(group.id) });
    });
    this.app.post("/api/groups/:groupId/reset", (req, res) => {
      const group = this.store.getGroup(req.params.groupId);
      const actorId = asString(req.body?.actorId);
      if (!group) return httpError(res, 404, "group not found");
      if (actorId !== group.ownerId) return httpError(res, 403, "only the group owner may reset a group");
      this.store.resetGroup(group.id);
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
          this.resolvePipelineWaitersForAgent(agentId);
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
      this.resolvePipelineAck(agentId, ack.groupId, ack.messageId, ack.seq);
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
      const created = this.appendAndBroadcast({
        groupId: group.id,
        sender: { type: "agent", id: agent.id, name: agent.displayName },
        content: outbound.content,
        parentMessageId: outbound.parentMessageId,
        rootMessageId: outbound.rootMessageId,
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
        pipelineStatuses: groups
          .map((group) => this.pipelineStatuses.get(group.id))
          .filter((status): status is PipelineStatusEvent => Boolean(status)),
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
      this.enqueuePipeline(group, createdMessage);
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
    return message;
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

  private enqueuePipeline(group: Group, rootMessage: StoredMessage): void {
    const previous = this.pipelineQueues.get(group.id) || Promise.resolve();
    const next = previous
      .then(() => this.runPipeline(group, rootMessage))
      .catch((error: unknown) => {
        console.error(`[${CHANNEL_ID}] pipeline failed group=${group.id}: ${String(error)}`);
      });
    this.pipelineQueues.set(group.id, next);
    void next.finally(() => {
      if (this.pipelineQueues.get(group.id) === next) this.pipelineQueues.delete(group.id);
    });
  }

  private async runPipeline(group: Group, rootMessage: StoredMessage): Promise<void> {
    const agents = this.store.getGroupMembers(group.id).filter((member) => member.memberType === "agent");
    const turn: PipelineTurn = {
      turnId: randomUUID(),
      groupId: group.id,
      rootMessageId: rootMessage.rootMessageId || rootMessage.id,
    };
    const agentStatuses = agents.map((member) => ({
      id: member.memberId,
      displayName: member.displayName,
      status: "waiting" as PipelineAgentStatus,
    }));

    this.publishPipelineStatus(group, {
      type: "pipeline.status",
      group: { id: group.id, name: group.name },
      turnId: turn.turnId,
      rootMessageId: turn.rootMessageId,
      state: "queued",
      step: 0,
      totalSteps: agents.length,
      agents: agentStatuses,
      updatedAt: new Date().toISOString(),
    });

    for (const [index, member] of agents.entries()) {
      const agentStatus = agentStatuses[index];
      if (!agentStatus) continue;
      const currentGroup = this.store.getGroup(group.id);
      if (!currentGroup) return;
      if (currentGroup.status === "paused") {
        for (const agent of agentStatuses) if (agent.status === "waiting" || agent.status === "replying") agent.status = "skipped";
        this.publishPipelineStatus(group, {
          type: "pipeline.status",
          group: { id: group.id, name: group.name },
          turnId: turn.turnId,
          rootMessageId: turn.rootMessageId,
          state: "completed",
          step: agents.length,
          totalSteps: agents.length,
          agents: agentStatuses,
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      if (!this.store.isMember(group.id, "agent", member.memberId)) {
        agentStatus.status = "skipped";
        this.publishPipelineStatus(group, this.pipelineStatusFor(turn, agents.length, agentStatuses, index + 1));
        continue;
      }

      const conversation = this.store
        .getMessages(group.id)
        .filter((message) => message.rootMessageId === turn.rootMessageId);
      const latest = conversation.at(-1) || rootMessage;
      const step: PipelineStep = {
        ...turn,
        agentId: member.memberId,
        messageId: latest.id,
        step: index + 1,
        totalSteps: agents.length,
      };
      const socket = this.agentSockets.get(member.memberId);
      agentStatus.status = "replying";
      this.publishPipelineStatus(group, this.pipelineStatusFor(turn, agents.length, agentStatuses, index + 1, member));
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        this.store.markDeliveryResult(latest.id, group.id, member.memberId, "queued");
        agentStatus.status = "offline";
        this.publishPipelineStatus(group, this.pipelineStatusFor(turn, agents.length, agentStatuses, index + 1));
        continue;
      }

      this.activePipelineSteps.set(group.id, step);
      const ackResultPromise = this.waitForPipelineAck(step);
      this.sendPipelineStep(socket, member, currentGroup, latest, step, conversation);
      const ackResult = await ackResultPromise;
      const currentMessages = this.store
        .getMessages(group.id)
        .filter((message) => message.rootMessageId === turn.rootMessageId);
      const hasVisibleReply = currentMessages.some(
        (message) => message.seq > latest.seq && message.sender.type === "agent" && message.sender.id === member.memberId,
      );
      if (this.activePipelineSteps.get(group.id) === step) this.activePipelineSteps.delete(group.id);

      if (ackResult === "timeout") agentStatus.status = "timeout";
      else if (ackResult === "offline") agentStatus.status = "offline";
      else agentStatus.status = hasVisibleReply ? "replied" : "skipped";
      this.publishPipelineStatus(group, this.pipelineStatusFor(turn, agents.length, agentStatuses, index + 1));
    }

    this.publishPipelineStatus(group, {
      type: "pipeline.status",
      group: { id: group.id, name: group.name },
      turnId: turn.turnId,
      rootMessageId: turn.rootMessageId,
      state: "completed",
      step: agents.length,
      totalSteps: agents.length,
      agents: agentStatuses,
      updatedAt: new Date().toISOString(),
    });
  }

  private sendPipelineStep(
    socket: WebSocket,
    member: GroupMember,
    group: Group,
    message: StoredMessage,
    step: PipelineStep,
    conversation: readonly StoredMessage[],
  ): void {
    const pipeline: AgentPipelineContext = {
      turnId: step.turnId,
      step: step.step,
      totalSteps: step.totalSteps,
      rootMessageId: step.rootMessageId,
    };
    sendJson(socket, this.buildAgentEvent(member, group, message, {
      pipeline,
      conversation,
      mentionState: pipelineMentionState(member.memberId, conversation),
    }));
    this.store.markDelivered(message.id, group.id, member.memberId);
  }

  private sendMessageToAgent(agentId: string, message: StoredMessage): void {
    const group = this.store.getGroup(message.groupId);
    const member = this.store.getGroupMembers(message.groupId).find((item) => item.memberType === "agent" && item.memberId === agentId);
    const socket = this.agentSockets.get(agentId);
    if (!group || !member || !socket) return;
    const active = this.activePipelineSteps.get(group.id);
    if (active?.agentId === agentId && active.messageId === message.id) {
      const conversation = this.store
        .getMessages(group.id)
        .filter((item) => item.rootMessageId === active.rootMessageId);
      this.sendPipelineStep(socket, member, group, message, active, conversation);
      return;
    }
    sendJson(socket, this.buildAgentEvent(member, group, message));
    this.store.markDelivered(message.id, group.id, agentId);
  }

  private buildAgentEvent(
    member: GroupMember,
    group: Group,
    message: StoredMessage,
    options: { pipeline?: AgentPipelineContext; conversation?: readonly StoredMessage[]; mentionState?: MentionState } = {},
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
        pipeline: options.pipeline,
        conversation: options.conversation,
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
        pipeline: options.pipeline,
      },
    };
  }

  private pipelineStatusFor(
    turn: PipelineTurn,
    totalSteps: number,
    agents: PipelineStatusEvent["agents"],
    step: number,
    currentMember?: GroupMember,
  ): PipelineStatusEvent {
    const currentAgent = currentMember
      ? { id: currentMember.memberId, displayName: currentMember.displayName }
      : agents.find((agent) => agent.status === "replying");
    return {
      type: "pipeline.status",
      group: { id: turn.groupId, name: this.store.getGroup(turn.groupId)?.name || turn.groupId },
      turnId: turn.turnId,
      rootMessageId: turn.rootMessageId,
      state: currentAgent ? "replying" : "queued",
      step,
      totalSteps,
      currentAgent: currentAgent ? { id: currentAgent.id, displayName: currentAgent.displayName } : undefined,
      agents,
      updatedAt: new Date().toISOString(),
    };
  }

  private publishPipelineStatus(group: Group, status: PipelineStatusEvent): void {
    this.pipelineStatuses.set(group.id, status);
    const humanMembers = this.store.getGroupMembers(group.id).filter((member) => member.memberType === "human");
    for (const member of humanMembers) {
      const sockets = this.userSockets.get(member.memberId);
      if (!sockets) continue;
      for (const socket of sockets) sendJson(socket, status);
    }
  }

  private waitForPipelineAck(step: PipelineStep): Promise<PipelineAckResult> {
    const key = this.pipelineAckKey(step.agentId, step.groupId, step.messageId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pipelineAckWaiters.delete(key);
        resolve("timeout");
      }, PIPELINE_ACK_TIMEOUT_MS);
      this.pipelineAckWaiters.set(key, {
        agentId: step.agentId,
        groupId: step.groupId,
        messageId: step.messageId,
        seq: this.store.getMessages(step.groupId).find((message) => message.id === step.messageId)?.seq || 0,
        resolve,
        timer,
      });
    });
  }

  private resolvePipelineAck(agentId: string, groupId: string, messageId: string | undefined, seq: number): void {
    for (const [key, waiter] of this.pipelineAckWaiters) {
      if (waiter.agentId !== agentId || waiter.groupId !== groupId) continue;
      if (messageId ? waiter.messageId !== messageId : waiter.seq > seq) continue;
      clearTimeout(waiter.timer);
      this.pipelineAckWaiters.delete(key);
      waiter.resolve("acked");
    }
  }

  private resolvePipelineWaitersForAgent(agentId: string): void {
    for (const [key, waiter] of this.pipelineAckWaiters) {
      if (waiter.agentId !== agentId) continue;
      clearTimeout(waiter.timer);
      this.pipelineAckWaiters.delete(key);
      waiter.resolve("offline");
    }
  }

  private pipelineAckKey(agentId: string, groupId: string, messageId: string): string {
    return `${agentId}:${groupId}:${messageId}`;
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
