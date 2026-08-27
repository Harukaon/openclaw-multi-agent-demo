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

export interface DeliveryContext {
  groupId: string;
  groupName: string;
  mentionState: MentionState;
  selfMessage: boolean;
}

export interface AgentMessageEvent {
  type: "message";
  group: Pick<Group, "id" | "name">;
  seq: number;
  messageId: string;
  sender: Sender;
  content: string;
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

export interface UserOutboundMessage {
  type: "user.message";
  groupId: string;
  content: string;
  parentMessageId?: string;
  rootMessageId?: string;
}
