export type MemberType = "human" | "agent";
export type MentionState = "SELF" | "DIRECT" | "OTHER" | "NONE";
export type SenderType = MemberType;

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatar?: string | null;
  createdAt: string;
}

export interface Agent {
  id: string;
  displayName: string;
  description?: string | null;
  avatar?: string | null;
  connectionStatus: "online" | "offline";
  lastSeenAt?: string | null;
  createdAt: string;
}

export interface Group {
  id: string;
  name: string;
  ownerId: string;
  status: "active" | "paused";
  createdAt: string;
  updatedAt: string;
}

export interface GroupMember {
  groupId: string;
  memberType: MemberType;
  memberId: string;
  role: "owner" | "member";
  displayName: string;
  joinedAt: string;
}

export interface Mention {
  type: MemberType;
  id: string;
  displayName: string;
}

export interface Sender {
  type: SenderType;
  id: string;
  name: string;
}

export interface StoredMessage {
  id: string;
  groupId: string;
  seq: number;
  sender: Sender;
  content: string;
  mentions: Mention[];
  parentMessageId?: string | null;
  rootMessageId?: string | null;
  depth: number;
  createdAt: string;
}

export interface AgentBroadcastContext {
  turnId: string;
  rootMessageId: string;
  depth: number;
  agentReplyCount: number;
  maxAgentReplies: number;
}

export type BroadcastAgentStatus = "waiting" | "replying" | "replied" | "no_reply" | "offline" | "timeout" | "limit";

export interface BroadcastAgentStatusEntry {
  id: string;
  displayName: string;
  status: BroadcastAgentStatus;
}

export interface BroadcastStatusEvent {
  type: "broadcast.status";
  group: Pick<Group, "id" | "name">;
  turnId: string;
  rootMessageId: string;
  state: "broadcasting" | "completed";
  activeAgents: Array<Pick<Agent, "id" | "displayName">>;
  agentReplyCount: number;
  maxAgentReplies: number;
  agents: BroadcastAgentStatusEntry[];
  updatedAt: string;
}

export interface DeliveryContext {
  groupId: string;
  groupName: string;
  mentionState: MentionState;
  selfMessage: boolean;
  broadcast?: AgentBroadcastContext;
}

export interface AgentMessageEvent {
  type: "message";
  group: Pick<Group, "id" | "name">;
  seq: number;
  messageId: string;
  sender: Sender;
  content: string;
  /** Platform-generated per-Agent prompt; the canonical message remains in content. */
  contentForAgent?: string;
  mentions: Mention[];
  parentMessageId?: string | null;
  rootMessageId?: string | null;
  depth: number;
  createdAt: string;
  deliveryContext: DeliveryContext;
}

export interface UserMessageEvent extends Omit<AgentMessageEvent, "deliveryContext"> {
  deliveryContext?: DeliveryContext;
}

export interface UserGroupsUpdatedEvent {
  type: "groups.updated";
  groups: Group[];
}

export interface AgentHello {
  type: "hello";
  agentId: string;
  token: string;
}

export interface AgentAck {
  type: "ack";
  groupId: string;
  messageId?: string;
  seq: number;
}

export interface AgentOutboundMessage {
  type: "agent.message";
  clientMessageId?: string;
  groupId: string;
  content: string;
  parentMessageId?: string;
  rootMessageId?: string;
  depth?: number;
}

export interface UserHello {
  type: "hello";
  userId: string;
}

export interface AgentMessageAccepted {
  type: "message.accepted";
  clientMessageId?: string;
  groupId: string;
  messageId: string;
  seq: number;
}

export interface AgentMessageSuppressed {
  type: "message.suppressed";
  clientMessageId?: string;
  groupId: string;
  reason: "max_agent_replies" | "turn_completed";
}

export interface UserOutboundMessage {
  type: "user.message";
  groupId: string;
  content: string;
  parentMessageId?: string;
  rootMessageId?: string;
}
