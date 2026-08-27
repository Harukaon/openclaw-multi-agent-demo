import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { parseMentions } from "./mention.js";
import type {
  Agent,
  Group,
  GroupMember,
  MemberType,
  Mention,
  MentionState,
  Sender,
  StoredMessage,
  User,
} from "./types.js";

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  avatar: string | null;
  created_at: string;
};

type AgentRow = {
  id: string;
  display_name: string;
  description: string | null;
  avatar: string | null;
  connection_status: "online" | "offline";
  last_seen_at: string | null;
  created_at: string;
};

type GroupRow = {
  id: string;
  name: string;
  owner_id: string;
  status: "active" | "paused";
  created_at: string;
  updated_at: string;
};

type MemberRow = {
  group_id: string;
  member_type: MemberType;
  member_id: string;
  role: "owner" | "member";
  display_name: string;
  joined_at: string;
};

type MessageRow = {
  id: string;
  group_id: string;
  seq: number;
  sender_type: MemberType;
  sender_id: string;
  sender_name: string;
  content: string;
  mentions: string;
  parent_message_id: string | null;
  root_message_id: string | null;
  depth: number;
  created_at: string;
};

type StateRow = {
  agent_id: string;
  group_id: string;
  last_ack_seq: number;
  last_delivery_at: string | null;
  status: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  avatar TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  connection_status TEXT NOT NULL DEFAULT 'offline' CHECK (connection_status IN ('online', 'offline')),
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_counters (
  group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  next_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_type TEXT NOT NULL CHECK (member_type IN ('human', 'agent')),
  member_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (group_id, member_type, member_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_member ON group_members(member_type, member_id);

CREATE TABLE IF NOT EXISTS agent_group_state (
  agent_id TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  last_ack_seq INTEGER NOT NULL DEFAULT 0,
  last_delivery_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (agent_id, group_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('human', 'agent')),
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  parent_message_id TEXT,
  root_message_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (group_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_group_seq ON messages(group_id, seq);

CREATE TABLE IF NOT EXISTS message_deliveries (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  mention_state TEXT NOT NULL CHECK (mention_state IN ('SELF', 'DIRECT', 'OTHER', 'NONE')),
  delivered_at TEXT,
  ack_at TEXT,
  result TEXT NOT NULL DEFAULT 'queued',
  response_message_id TEXT,
  latency_ms INTEGER,
  PRIMARY KEY (message_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_agent_group ON message_deliveries(agent_id, group_id, message_id);
`;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatar: row.avatar,
    createdAt: row.created_at,
  };
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    displayName: row.display_name,
    description: row.description,
    avatar: row.avatar,
    connectionStatus: row.connection_status,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function toGroup(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMember(row: MemberRow): GroupMember {
  return {
    groupId: row.group_id,
    memberType: row.member_type,
    memberId: row.member_id,
    role: row.role,
    displayName: row.display_name,
    joinedAt: row.joined_at,
  };
}

function toMessage(row: MessageRow): StoredMessage {
  let mentions: Mention[] = [];
  try {
    const parsed: unknown = JSON.parse(row.mentions);
    if (Array.isArray(parsed)) mentions = parsed as Mention[];
  } catch {
    mentions = [];
  }
  return {
    id: row.id,
    groupId: row.group_id,
    seq: row.seq,
    sender: {
      type: row.sender_type,
      id: row.sender_id,
      name: row.sender_name,
    },
    content: row.content,
    mentions,
    parentMessageId: row.parent_message_id,
    rootMessageId: row.root_message_id,
    depth: row.depth,
    createdAt: row.created_at,
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(filename = ":memory:") {
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { recursive: true });
    }
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys = ON;");
    if (filename !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  createUser(input: { id?: string; username: string; displayName: string }): User {
    const now = new Date().toISOString();
    const id = input.id?.trim() || randomUUID();
    const username = input.username.trim().toLowerCase();
    const displayName = input.displayName.trim();
    if (!username || !displayName) throw new Error("username and displayName are required");
    this.db
      .prepare("INSERT INTO users (id, username, display_name, created_at) VALUES (?, ?, ?, ?)")
      .run(id, username, displayName, now);
    return this.getUser(id) as User;
  }

  getUser(id: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  listUsers(): User[] {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY created_at, id").all() as UserRow[];
    return rows.map(toUser);
  }

  createAgent(input: {
    id?: string;
    displayName: string;
    description?: string;
    avatar?: string;
  }): { agent: Agent; token: string } {
    const now = new Date().toISOString();
    const id = input.id?.trim() || randomUUID();
    const displayName = input.displayName.trim();
    if (!displayName) throw new Error("displayName is required");
    const token = `ag_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    this.db
      .prepare(
        `INSERT INTO agents (id, display_name, description, avatar, token_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, displayName, input.description?.trim() || null, input.avatar?.trim() || null, hashToken(token), now);
    return { agent: this.getAgent(id) as Agent, token };
  }

  getAgent(id: string): Agent | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    return row ? toAgent(row) : null;
  }

  authenticateAgent(id: string, token: string): Agent | null {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE id = ? AND token_hash = ?")
      .get(id, hashToken(token)) as AgentRow | undefined;
    return row ? toAgent(row) : null;
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY created_at, id").all() as AgentRow[];
    return rows.map(toAgent);
  }

  setAgentConnection(agentId: string, online: boolean): void {
    this.db
      .prepare("UPDATE agents SET connection_status = ?, last_seen_at = ? WHERE id = ?")
      .run(online ? "online" : "offline", new Date().toISOString(), agentId);
  }

  createGroup(input: { id?: string; name: string; ownerId: string }): Group {
    const now = new Date().toISOString();
    const id = input.id?.trim() || randomUUID();
    const name = input.name.trim();
    if (!name) throw new Error("name is required");
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO groups (id, name, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, name, input.ownerId, now, now);
      this.db.prepare("INSERT INTO group_counters (group_id, next_seq) VALUES (?, 0)").run(id);
      this.db
        .prepare(
          `INSERT INTO group_members (group_id, member_type, member_id, role, joined_at)
           VALUES (?, 'human', ?, 'owner', ?)`,
        )
        .run(id, input.ownerId, now);
    });
    return this.getGroup(id) as Group;
  }

  getGroup(id: string): Group | null {
    const row = this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;
    return row ? toGroup(row) : null;
  }

  listGroupsForUser(userId: string): Group[] {
    const rows = this.db
      .prepare(
        `SELECT g.* FROM groups g
         JOIN group_members gm ON gm.group_id = g.id
         WHERE gm.member_type = 'human' AND gm.member_id = ?
         ORDER BY g.updated_at DESC, g.id`,
      )
      .all(userId) as GroupRow[];
    return rows.map(toGroup);
  }

  listGroupsForAgent(agentId: string): Group[] {
    const rows = this.db
      .prepare(
        `SELECT g.* FROM groups g
         JOIN group_members gm ON gm.group_id = g.id
         WHERE gm.member_type = 'agent' AND gm.member_id = ?
         ORDER BY g.updated_at, g.id`,
      )
      .all(agentId) as GroupRow[];
    return rows.map(toGroup);
  }

  getGroupMembers(groupId: string): GroupMember[] {
    const rows = this.db
      .prepare(
        `SELECT gm.group_id, gm.member_type, gm.member_id, gm.role, gm.joined_at,
                CASE WHEN gm.member_type = 'human' THEN u.display_name ELSE a.display_name END AS display_name
         FROM group_members gm
         LEFT JOIN users u ON gm.member_type = 'human' AND u.id = gm.member_id
         LEFT JOIN agents a ON gm.member_type = 'agent' AND a.id = gm.member_id
         WHERE gm.group_id = ?
         ORDER BY gm.member_type, gm.joined_at, gm.member_id`,
      )
      .all(groupId) as MemberRow[];
    return rows.map(toMember);
  }

  isMember(groupId: string, memberType: MemberType, memberId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM group_members WHERE group_id = ? AND member_type = ? AND member_id = ?")
      .get(groupId, memberType, memberId) as { ok: number } | undefined;
    return Boolean(row);
  }

  addMember(input: { groupId: string; memberType: MemberType; memberId: string; role?: "owner" | "member" }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO group_members (group_id, member_type, member_id, role, joined_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.groupId, input.memberType, input.memberId, input.role ?? "member", now);
    if (input.memberType === "agent") {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO agent_group_state (agent_id, group_id, last_ack_seq, status)
           VALUES (?, ?, 0, 'active')`,
        )
        .run(input.memberId, input.groupId);
    }
  }

  removeMember(groupId: string, memberType: MemberType, memberId: string): void {
    this.db
      .prepare("DELETE FROM group_members WHERE group_id = ? AND member_type = ? AND member_id = ?")
      .run(groupId, memberType, memberId);
  }

  setGroupStatus(groupId: string, status: "active" | "paused"): void {
    this.db
      .prepare("UPDATE groups SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), groupId);
  }

  appendMessage(input: {
    groupId: string;
    sender: Sender;
    content: string;
    parentMessageId?: string;
    rootMessageId?: string;
    depth?: number;
  }): StoredMessage {
    const content = input.content.trim();
    if (!content) throw new Error("content is required");
    const messageId = randomUUID();
    const now = new Date().toISOString();
    const members = this.getGroupMembers(input.groupId);
    const mentions = parseMentions(content, members);
    const messageRow = this.transaction(() => {
      const counter = this.db
        .prepare("SELECT next_seq FROM group_counters WHERE group_id = ?")
        .get(input.groupId) as { next_seq: number } | undefined;
      if (!counter) throw new Error("group not found");
      const seq = Number(counter.next_seq) + 1;
      this.db.prepare("UPDATE group_counters SET next_seq = ? WHERE group_id = ?").run(seq, input.groupId);
      this.db
        .prepare(
          `INSERT INTO messages
           (id, group_id, seq, sender_type, sender_id, sender_name, content, mentions,
            parent_message_id, root_message_id, depth, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          input.groupId,
          seq,
          input.sender.type,
          input.sender.id,
          input.sender.name,
          content,
          JSON.stringify(mentions),
          input.parentMessageId ?? null,
          input.rootMessageId ?? null,
          input.depth ?? 0,
          now,
        );
      const agents = members.filter((member) => member.memberType === "agent");
      for (const agent of agents) {
        const selfMessage = input.sender.type === "agent" && input.sender.id === agent.memberId;
        const mentionState: MentionState = selfMessage
          ? "SELF"
          : mentions.some((mention) => mention.type === "agent" && mention.id === agent.memberId)
            ? "DIRECT"
            : mentions.length > 0
              ? "OTHER"
              : "NONE";
        this.db
          .prepare(
            `INSERT INTO message_deliveries
             (message_id, group_id, agent_id, mention_state, result)
             VALUES (?, ?, ?, ?, 'queued')`,
          )
          .run(messageId, input.groupId, agent.memberId, mentionState);
      }
      this.db.prepare("UPDATE groups SET updated_at = ? WHERE id = ?").run(now, input.groupId);
      return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow;
    });
    return toMessage(messageRow);
  }

  getMessages(groupId: string, afterSeq = 0, limit = 200): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE group_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(groupId, afterSeq, Math.min(Math.max(limit, 1), 1000)) as MessageRow[];
    return rows.map(toMessage);
  }

  markDelivered(messageId: string, groupId: string, agentId: string): void {
    this.db
      .prepare(
        `UPDATE message_deliveries
         SET delivered_at = COALESCE(delivered_at, ?), result = 'delivered'
         WHERE message_id = ? AND group_id = ? AND agent_id = ?`,
      )
      .run(new Date().toISOString(), messageId, groupId, agentId);
    this.db
      .prepare("UPDATE agent_group_state SET last_delivery_at = ? WHERE agent_id = ? AND group_id = ?")
      .run(new Date().toISOString(), agentId, groupId);
  }

  markDeliveryResult(messageId: string, groupId: string, agentId: string, result: string): void {
    this.db
      .prepare("UPDATE message_deliveries SET result = ? WHERE message_id = ? AND group_id = ? AND agent_id = ?")
      .run(result, messageId, groupId, agentId);
  }

  ack(input: { agentId: string; groupId: string; seq: number; messageId?: string }): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agent_group_state (agent_id, group_id, last_ack_seq, last_delivery_at, status)
           VALUES (?, ?, ?, ?, 'active')
           ON CONFLICT(agent_id, group_id) DO UPDATE SET
             last_ack_seq = MAX(agent_group_state.last_ack_seq, excluded.last_ack_seq),
             last_delivery_at = excluded.last_delivery_at`,
        )
        .run(input.agentId, input.groupId, input.seq, now);
      if (input.messageId) {
        this.db
          .prepare(
            `UPDATE message_deliveries SET ack_at = ?, result = 'acked'
             WHERE message_id = ? AND group_id = ? AND agent_id = ?`,
          )
          .run(now, input.messageId, input.groupId, input.agentId);
      } else {
        this.db
          .prepare(
            `UPDATE message_deliveries SET ack_at = ?, result = 'acked'
             WHERE group_id = ? AND agent_id = ?
             AND message_id IN (SELECT id FROM messages WHERE group_id = ? AND seq <= ?)`,
          )
          .run(now, input.groupId, input.agentId, input.groupId, input.seq);
      }
    });
  }

  latestSeq(groupId: string): number {
    const row = this.db
      .prepare("SELECT next_seq FROM group_counters WHERE group_id = ?")
      .get(groupId) as { next_seq: number } | undefined;
    return row?.next_seq ?? 0;
  }

  getAgentAck(agentId: string, groupId: string): number {
    const row = this.db
      .prepare("SELECT last_ack_seq FROM agent_group_state WHERE agent_id = ? AND group_id = ?")
      .get(agentId, groupId) as { last_ack_seq: number } | undefined;
    return row?.last_ack_seq ?? 0;
  }

  getAgentGroupStates(agentId: string): StateRow[] {
    return this.db
      .prepare("SELECT * FROM agent_group_state WHERE agent_id = ? ORDER BY group_id")
      .all(agentId) as StateRow[];
  }

  resetGroup(groupId: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM messages WHERE group_id = ?").run(groupId);
      this.db.prepare("UPDATE group_counters SET next_seq = 0 WHERE group_id = ?").run(groupId);
      this.db.prepare("UPDATE agent_group_state SET last_ack_seq = 0, last_delivery_at = NULL WHERE group_id = ?").run(groupId);
      this.db.prepare("UPDATE groups SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), groupId);
    });
  }

  countOnlineAgents(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM agents WHERE connection_status = 'online'").get() as { count: number };
    return Number(row.count);
  }

  countGroups(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM groups").get() as { count: number };
    return Number(row.count);
  }
}
