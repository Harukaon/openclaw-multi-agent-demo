import { createChatChannelPlugin, createChannelPluginBase } from "openclaw/plugin-sdk/channel-core";
import type { ChannelGatewayContext, ChannelPlugin } from "openclaw/plugin-sdk";
import { GroupChatClient, type GroupChatClientMessage } from "./client.js";

export const CHANNEL_ID = "feedmob-group-chat";

type ResolvedAccount = {
  accountId: string;
  serverUrl: string;
  agentId: string;
  openclawAgentId: string;
  token: string;
  requireMention: boolean;
};

type RuntimeChannel = {
  routing: {
    resolveAgentRoute: (params: Record<string, unknown>) => {
      agentId: string;
      accountId: string;
      sessionKey: string;
      dmScope?: string;
      groupScope?: string;
    };
  };
  inbound: {
    buildContext: (params: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
    run: (params: Record<string, unknown>) => Promise<{ dispatched: boolean; admission?: unknown }>;
  };
};

type GatewayContext = ChannelGatewayContext<ResolvedAccount>;

type EventGroup = { id: string; name: string };
type EventSender = { type: "human" | "agent"; id: string; name: string };
type GroupMessageEvent = GroupChatClientMessage & {
  type: "message";
  group: EventGroup;
  seq: number;
  messageId: string;
  sender: EventSender;
  content: string;
  mentions: Array<Record<string, unknown>>;
  parentMessageId?: string;
  rootMessageId?: string;
  depth: number;
  createdAt: string;
  deliveryContext?: {
    groupId: string;
    groupName: string;
    mentionState: "SELF" | "DIRECT" | "OTHER" | "NONE";
    selfMessage: boolean;
  };
};

const clients = new Map<string, GroupChatClient>();

function accountSection(cfg: Record<string, unknown>, accountId = "default"): Record<string, unknown> {
  const channels = (cfg.channels || {}) as Record<string, unknown>;
  const section = (channels[CHANNEL_ID] || {}) as Record<string, unknown>;
  const accounts = (section.accounts || {}) as Record<string, Record<string, unknown>>;
  return { ...section, ...(accounts[accountId] || {}) };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${CHANNEL_ID}: ${name} is required`);
  return value.trim();
}

function resolveAccount(cfg: Record<string, unknown>, accountId?: string | null): ResolvedAccount {
  const id = accountId?.trim() || "default";
  const section = accountSection(cfg, id);
  return {
    accountId: id,
    serverUrl: requiredString(section.serverUrl || process.env.FEEDMOB_GROUP_SERVER_URL, "serverUrl"),
    agentId: requiredString(section.agentId || process.env.FEEDMOB_GROUP_AGENT_ID, "agentId"),
    openclawAgentId: typeof section.openclawAgentId === "string" && section.openclawAgentId.trim()
      ? section.openclawAgentId.trim()
      : (process.env.FEEDMOB_OPENCLAW_AGENT_ID?.trim() || "main"),
    token: requiredString(section.token || process.env.FEEDMOB_GROUP_AGENT_TOKEN, "token"),
    requireMention: section.requireMention === true || process.env.FEEDMOB_GROUP_REQUIRE_MENTION === "true",
  };
}

function getChannelRuntime(ctx: GatewayContext): RuntimeChannel {
  const runtimeChannel = ctx.channelRuntime as unknown as RuntimeChannel | undefined;
  if (!runtimeChannel?.inbound?.run || !runtimeChannel.routing?.resolveAgentRoute) {
    throw new Error(`${CHANNEL_ID}: OpenClaw channel runtime is unavailable`);
  }
  return runtimeChannel;
}

function asGroupMessage(message: GroupChatClientMessage): GroupMessageEvent | null {
  if (message.type !== "message") return null;
  if (!message.group || typeof message.group !== "object") return null;
  if (!message.sender || typeof message.sender !== "object") return null;
  const group = message.group as { id?: unknown; name?: unknown };
  if (typeof group.id !== "string" || typeof group.name !== "string") return null;
  if (typeof message.messageId !== "string" || typeof message.content !== "string") return null;
  return message as GroupMessageEvent;
}

function targetGroupId(target: unknown): string {
  const value = typeof target === "string" ? target.trim() : "";
  return value.replace(/^(feedmob-group-chat:|group:|conversation:)/i, "");
}

async function handleInboundMessage(ctx: GatewayContext, client: GroupChatClient, event: GroupMessageEvent): Promise<void> {
  const delivery = event.deliveryContext;
  const mentionState = delivery?.mentionState || "NONE";
  if (delivery?.selfMessage || mentionState === "SELF" || event.sender.id === ctx.account.agentId) {
    client.send({ type: "ack", groupId: event.group.id, seq: event.seq, messageId: event.messageId });
    return;
  }
  if (ctx.account.requireMention && mentionState !== "DIRECT") {
    client.send({ type: "ack", groupId: event.group.id, seq: event.seq, messageId: event.messageId });
    ctx.log?.info?.(`ignored non-mentioned message group=${event.group.id} seq=${event.seq}`);
    return;
  }

  const channel = getChannelRuntime(ctx);
  const peer = { kind: "group", id: `group:${event.group.id}` };
  const route = channel.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    defaultAgentId: ctx.account.openclawAgentId,
    peer,
    groupScope: "per-group",
  });
  const ctxPayload = await channel.inbound.buildContext({
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    messageId: event.messageId,
    timestamp: Date.parse(event.createdAt),
    from: event.sender.id,
    sender: {
      id: event.sender.id,
      name: event.sender.name,
      displayLabel: event.sender.name,
      isBot: event.sender.type === "agent",
      isSelf: false,
    },
    conversation: {
      kind: "group",
      id: event.group.id,
      label: event.group.name,
      routePeer: peer,
    },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      groupScope: "per-group",
    },
    reply: {
      to: event.group.id,
      originatingTo: event.group.id,
      deliveryTarget: event.group.id,
      replyToId: event.messageId,
      sourceReplyDeliveryMode: "reply",
    },
    message: {
      inboundEventKind: "user_request",
      body: event.content,
      rawBody: event.content,
      bodyForAgent: event.content,
      senderLabel: event.sender.name,
    },
    access: {
      mentions: {
        canDetectMention: true,
        wasMentioned: mentionState === "DIRECT",
        effectiveWasMentioned: mentionState === "DIRECT",
        requireMention: ctx.account.requireMention,
      },
    },
    channelIngress: "unsupported",
    extra: {
      feedmobGroupId: event.group.id,
      feedmobGroupName: event.group.name,
      feedmobSeq: event.seq,
      feedmobMentionState: mentionState,
    },
  });

  const result = await channel.inbound.run({
    channel: CHANNEL_ID,
    accountId: ctx.accountId,
    raw: event,
    adapter: {
      ingest: () => ({
        id: event.messageId,
        timestamp: Date.parse(event.createdAt),
        rawText: event.content,
        textForAgent: event.content,
        textForCommands: event.content,
        raw: event,
      }),
      resolveTurn: () => ({
        cfg: ctx.cfg,
        channel: CHANNEL_ID,
        accountId: ctx.accountId,
        route: {
          agentId: route.agentId,
          sessionKey: route.sessionKey,
        },
        ctxPayload,
        messageId: event.messageId,
        delivery: {
          observeMessageSent: true,
          deliver: async (payload: { text?: string }) => {
            const text = typeof payload.text === "string" ? payload.text.trim() : "";
            if (!text) return { visibleReplySent: false };
            const accepted = await client.sendAgentMessage({
              groupId: event.group.id,
              content: text,
              parentMessageId: event.messageId,
              rootMessageId: event.rootMessageId || event.messageId,
              depth: event.depth + 1,
            });
            return { content: text, messageIds: [accepted.messageId], visibleReplySent: true };
          },
          onError: (error: unknown) => ctx.log?.error?.(`${CHANNEL_ID}: delivery failed: ${String(error)}`),
        },
      }),
    },
  });
  if (result.dispatched || result.admission) {
    client.send({ type: "ack", groupId: event.group.id, seq: event.seq, messageId: event.messageId });
  }
}

const accountConfig = {
  listAccountIds: () => ["default"],
  resolveAccount,
  inspectAccount: (cfg: Record<string, unknown>, accountId?: string | null) => {
    const section = accountSection(cfg, accountId || "default");
    const serverUrl = section.serverUrl || process.env.FEEDMOB_GROUP_SERVER_URL;
    const agentId = section.agentId || process.env.FEEDMOB_GROUP_AGENT_ID;
    const token = section.token || process.env.FEEDMOB_GROUP_AGENT_TOKEN;
    const configured = Boolean(serverUrl && agentId && token);
    return { enabled: configured, configured, tokenStatus: token ? "available" : "missing" };
  },
};

const feedmobGroupChatPlugin: ChannelPlugin<ResolvedAccount> = {
  ...createChatChannelPlugin({
  base: {
    ...createChannelPluginBase({
      id: CHANNEL_ID,
    meta: {
      label: "FeedMob Group Chat",
      selectionLabel: "FeedMob Group Chat",
      docsPath: "/plugins/feedmob-group-chat",
      blurb: "Group-scoped multi-Agent chat over a FeedMob platform server.",
    },
    capabilities: {
      chatTypes: ["group"],
      media: false,
      nativeCommands: false,
      blockStreaming: false,
    },
    config: accountConfig,
    setup: {
      applyAccountConfig: ({ cfg, input }: { cfg: Record<string, unknown>; input: Record<string, unknown> }) => ({
        ...cfg,
        channels: {
          ...(cfg.channels || {}),
          [CHANNEL_ID]: { ...accountSection(cfg), ...input },
        },
      }),
    },
    groups: {
      resolveRequireMention: ({ cfg, accountId }: { cfg: Record<string, unknown>; accountId?: string | null }) => resolveAccount(cfg, accountId).requireMention,
    },
    }),
    capabilities: {
      chatTypes: ["group"],
      media: false,
      nativeCommands: false,
      blockStreaming: false,
    },
    config: accountConfig,
  },
  threading: { topLevelReplyToMode: "reply" },
  outbound: {
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async (params: { to: string; text: string; accountId?: string | null }) => {
        const client = clients.get(params.accountId || "default");
        if (!client) throw new Error(`${CHANNEL_ID}: account is not connected`);
        const groupId = targetGroupId(params.to);
        const accepted = await client.sendAgentMessage({ groupId, content: params.text });
        return { messageId: accepted.messageId };
      },
    },
    base: { deliveryMode: "direct" },
    },
  }),
  gateway: {
    startAccount: async (rawCtx: GatewayContext) => {
      const ctx = rawCtx;
      const client = new GroupChatClient({
        serverUrl: ctx.account.serverUrl,
        agentId: ctx.account.agentId,
        token: ctx.account.token,
        log: (message) => ctx.log?.warn?.(`${CHANNEL_ID}: ${message}`),
      });
      clients.set(ctx.accountId, client);
      ctx.setStatus({ accountId: ctx.accountId, running: true, connected: false, statusState: "starting" });
      const queues = new Map<string, Promise<void>>();
      const onMessage = async (message: GroupChatClientMessage) => {
        const event = asGroupMessage(message);
        if (!event) return;
        const previous = queues.get(event.group.id) || Promise.resolve();
        const next = previous.then(() => handleInboundMessage(ctx, client, event));
        queues.set(event.group.id, next.catch(() => undefined));
        await next;
      };
      try {
        await client.run(
          ctx.abortSignal,
          onMessage,
          () => ctx.setStatus({ accountId: ctx.accountId, running: true, connected: true, statusState: "connected" }),
          () => ctx.setStatus({ accountId: ctx.accountId, running: true, connected: false, statusState: "reconnecting" }),
        );
      } finally {
        if (clients.get(ctx.accountId) === client) clients.delete(ctx.accountId);
        client.close();
        ctx.setStatus({ accountId: ctx.accountId, running: false, connected: false, statusState: "stopped" });
      }
    },
  },
};

export { feedmobGroupChatPlugin };
