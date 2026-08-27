import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { Store } from "../src/store.js";
import { PlatformServer } from "../src/server.js";

test("group-scoped sequence and mention parsing stay isolated", () => {
  const store = new Store();
  try {
    const ownerA = store.createUser({ id: "user-a", username: "user-a", displayName: "User A" });
    const ownerB = store.createUser({ id: "user-b", username: "user-b", displayName: "User B" });
    const agentA = store.createAgent({ id: "agent-a", displayName: "Agent A" });
    const agentB = store.createAgent({ id: "agent-b", displayName: "Agent B" });
    const groupA = store.createGroup({ id: "group-a", name: "Alpha", ownerId: ownerA.id });
    const groupB = store.createGroup({ id: "group-b", name: "Beta", ownerId: ownerB.id });
    store.addMember({ groupId: groupA.id, memberType: "agent", memberId: agentA.agent.id });
    store.addMember({ groupId: groupA.id, memberType: "agent", memberId: agentB.agent.id });
    store.addMember({ groupId: groupB.id, memberType: "agent", memberId: agentA.agent.id });

    const alpha = store.appendMessage({
      groupId: groupA.id,
      sender: { type: "human", id: ownerA.id, name: ownerA.displayName },
      content: "@agent-a handle Alpha",
    });
    const beta = store.appendMessage({
      groupId: groupB.id,
      sender: { type: "human", id: ownerB.id, name: ownerB.displayName },
      content: "Beta task",
    });

    assert.equal(alpha.seq, 1);
    assert.equal(beta.seq, 1);
    assert.deepEqual(alpha.mentions.map((item) => item.id), ["agent-a"]);
    assert.deepEqual(store.getMessages(groupA.id).map((item) => item.content), ["@agent-a handle Alpha"]);
    assert.deepEqual(store.getMessages(groupB.id).map((item) => item.content), ["Beta task"]);
    assert.equal(store.latestSeq(groupA.id), 1);
    assert.equal(store.latestSeq(groupB.id), 1);
    assert.deepEqual(store.listGroupsForAgent(agentA.agent.id).map((item) => item.id), ["group-a", "group-b"]);
    assert.deepEqual(store.listGroupsForAgent(agentB.agent.id).map((item) => item.id), ["group-a"]);
  } finally {
    store.close();
  }
});

test("admin token protects REST mutations without affecting health", async () => {
  const store = new Store();
  const server = new PlatformServer(store, "admin-secret");
  try {
    await server.listen(0, "127.0.0.1");
    const address = server.httpServer.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/api/users`;
    const rejected = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "blocked", displayName: "Blocked" }),
    });
    assert.equal(rejected.status, 401);
    const accepted = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
      body: JSON.stringify({ username: "accepted", displayName: "Accepted" }),
    });
    assert.equal(accepted.status, 201);
  } finally {
    await server.stop().catch(() => undefined);
  }
});

type SocketHarness = {
  socket: WebSocket;
  events: Array<Record<string, unknown>>;
  waitFor: (predicate: (event: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
};

function connectAgent(port: number, agentId: string, token: string): Promise<SocketHarness> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
    const events: Array<Record<string, unknown>> = [];
    const waiters: Array<{
      predicate: (event: Record<string, unknown>) => boolean;
      resolve: (event: Record<string, unknown>) => void;
    }> = [];
    const harness: SocketHarness = {
      socket,
      events,
      waitFor: (predicate) => {
        const existing = events.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((waitResolve) => waiters.push({ predicate, resolve: waitResolve }));
      },
    };
    socket.on("open", () => socket.send(JSON.stringify({ type: "hello", agentId, token })));
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      events.push(event);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(event)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
      if (event.type === "hello.ok") resolve(harness);
    });
    socket.once("error", reject);
  });
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
  });
}

test("one Agent connection receives only its Group memberships and replays per Group", async () => {
  const store = new Store();
  const server = new PlatformServer(store);
  let agentA: SocketHarness | undefined;
  let agentB: SocketHarness | undefined;
  try {
    const ownerA = store.createUser({ id: "owner-a", username: "owner-a", displayName: "Owner A" });
    const ownerB = store.createUser({ id: "owner-b", username: "owner-b", displayName: "Owner B" });
    const createdA = store.createAgent({ id: "agent-a", displayName: "Agent A" });
    const createdB = store.createAgent({ id: "agent-b", displayName: "Agent B" });
    const groupA = store.createGroup({ id: "group-a", name: "Group A", ownerId: ownerA.id });
    const groupB = store.createGroup({ id: "group-b", name: "Group B", ownerId: ownerB.id });
    store.addMember({ groupId: groupA.id, memberType: "agent", memberId: createdA.agent.id });
    store.addMember({ groupId: groupA.id, memberType: "agent", memberId: createdB.agent.id });
    store.addMember({ groupId: groupB.id, memberType: "agent", memberId: createdA.agent.id });

    await server.listen(0, "127.0.0.1");
    const address = server.httpServer.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    agentA = await connectAgent(port, createdA.agent.id, createdA.token);
    agentB = await connectAgent(port, createdB.agent.id, createdB.token);

    await postJson(`http://127.0.0.1:${port}/api/groups/group-a/messages`, {
      senderType: "human",
      senderId: ownerA.id,
      content: "Alpha-only message",
    });
    await postJson(`http://127.0.0.1:${port}/api/groups/group-b/messages`, {
      senderType: "human",
      senderId: ownerB.id,
      content: "Beta-only message",
    });

    const alphaForA = await agentA.waitFor((event) => event.type === "message" && event.group !== undefined && (event.group as Record<string, unknown>).id === "group-a");
    const betaForA = await agentA.waitFor((event) => event.type === "message" && event.group !== undefined && (event.group as Record<string, unknown>).id === "group-b");
    const alphaForB = await agentB.waitFor((event) => event.type === "message" && event.group !== undefined && (event.group as Record<string, unknown>).id === "group-a");
    assert.equal((alphaForA.group as Record<string, unknown>).id, "group-a");
    assert.equal((betaForA.group as Record<string, unknown>).id, "group-b");
    assert.equal((alphaForB.group as Record<string, unknown>).id, "group-a");
    assert.equal(agentB.events.some((event) => event.type === "message" && event.group !== undefined && (event.group as Record<string, unknown>).id === "group-b"), false);

    agentA.socket.send(JSON.stringify({ type: "agent.message", clientMessageId: "reply-1", groupId: "group-a", content: "Agent A reply" }));
    const accepted = await agentA.waitFor((event) => event.type === "message.accepted" && event.clientMessageId === "reply-1");
    const replyForB = await agentB.waitFor((event) => event.type === "message" && event.content === "Agent A reply");
    assert.equal(accepted.groupId, "group-a");
    assert.equal(typeof accepted.messageId, "string");
    assert.equal(replyForB.sender && (replyForB.sender as Record<string, unknown>).id, "agent-a");

    agentA.socket.send(JSON.stringify({ type: "ack", groupId: "group-a", seq: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await closeSocket(agentA.socket);
    agentA = await connectAgent(port, createdA.agent.id, createdA.token);
    await postJson(`http://127.0.0.1:${port}/api/groups/group-a/messages`, {
      senderType: "human",
      senderId: ownerA.id,
      content: "Alpha replay message",
    });
    await postJson(`http://127.0.0.1:${port}/api/groups/group-b/messages`, {
      senderType: "human",
      senderId: ownerB.id,
      content: "Beta replay message",
    });
    const replayAlpha = await agentA.waitFor((event) => event.type === "message" && event.content === "Alpha replay message");
    const replayBeta = await agentA.waitFor((event) => event.type === "message" && event.content === "Beta replay message");
    assert.equal(replayAlpha.seq, 3);
    assert.equal(replayBeta.seq, 2);
    assert.equal(store.getAgentAck(createdA.agent.id, groupA.id), 2);
    assert.equal(store.getAgentAck(createdA.agent.id, groupB.id), 0);
  } finally {
    if (agentA) await closeSocket(agentA.socket);
    if (agentB) await closeSocket(agentB.socket);
    await server.stop().catch(() => undefined);
  }
});
