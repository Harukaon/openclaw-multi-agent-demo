import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { Store } from "../src/store.js";
import { PlatformServer } from "../src/server.js";
import { buildAgentContentForAgent } from "../src/agent-prompt.js";

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

test("Agent prompt injection preserves the message and explains each mention state", () => {
  const base = {
    agent: { id: "agent-a", displayName: "Agent A" },
    group: { id: "group-a", name: "Demo Room" },
    sender: { type: "human" as const, id: "user-a", name: "User A" },
    content: "Please review this",
  };

  const direct = buildAgentContentForAgent({ ...base, mentionState: "DIRECT" });
  assert.match(direct, /Current Group: group-a \(Demo Room\)/);
  assert.match(direct, /Current Agent: agent-a \(Agent A\)/);
  assert.match(direct, /Mention State: DIRECT/);
  assert.match(direct, /直接 @ 了你/);
  assert.match(direct, /Please review this/);

  const other = buildAgentContentForAgent({ ...base, mentionState: "OTHER" });
  assert.match(other, /Mention State: OTHER/);
  assert.match(other, /指向其他群成员或 Agent/);

  const none = buildAgentContentForAgent({ ...base, mentionState: "NONE" });
  assert.match(none, /Mention State: NONE/);
  assert.match(none, /没有 @ 任何群成员/);

  const self = buildAgentContentForAgent({ ...base, mentionState: "SELF" });
  assert.match(self, /Mention State: SELF/);
  assert.match(self, /由你自己发出/);
});

test("demo REST mutations are available without an admin token", async () => {
  const store = new Store();
  const server = new PlatformServer(store);
  try {
    await server.listen(0, "127.0.0.1");
    const address = server.httpServer.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/api/users`;
    const created = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "demo-user", displayName: "Demo User" }),
    });
    assert.equal(created.status, 201);
    const user = (await created.json()).user as { id: string };
    const agentResponse = await fetch(`http://127.0.0.1:${address.port}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Demo Agent" }),
    });
    assert.equal(agentResponse.status, 201);
    const agent = (await agentResponse.json()).agent as { id: string };
    const groupResponse = await fetch(`http://127.0.0.1:${address.port}/api/groups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Demo Group", ownerId: user.id }),
    });
    assert.equal(groupResponse.status, 201);
    const group = (await groupResponse.json()).group as { id: string };
    const memberResponse = await fetch(`http://127.0.0.1:${address.port}/api/groups/${group.id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorId: user.id, memberType: "agent", memberId: agent.id }),
    });
    assert.equal(memberResponse.status, 201);
  } finally {
    await server.stop().catch(() => undefined);
  }
});

type SocketHarness = {
  socket: WebSocket;
  events: Array<Record<string, unknown>>;
  waitFor: (predicate: (event: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
};

function connectAgent(port: number, agentId: string, token: string): Promise<SocketHarness> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
    const events: Array<Record<string, unknown>> = [];
    const waiters: Array<{
      predicate: (event: Record<string, unknown>) => boolean;
      resolve: (event: Record<string, unknown>) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];
    const harness: SocketHarness = {
      socket,
      events,
      waitFor: (predicate, timeoutMs = 5000) => {
        const existing = events.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((waitResolve, waitReject) => {
          const waiter = {
            predicate,
            resolve: (event: Record<string, unknown>) => {
              clearTimeout(waiter.timer);
              waitResolve(event);
            },
            timer: setTimeout(() => {
              waiters.splice(waiters.indexOf(waiter), 1);
              waitReject(new Error("timed out waiting for test websocket event"));
            }, timeoutMs),
          };
          waiters.push(waiter);
        });
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

function connectUser(port: number, userId: string): Promise<SocketHarness> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/user`);
    const events: Array<Record<string, unknown>> = [];
    const waiters: Array<{
      predicate: (event: Record<string, unknown>) => boolean;
      resolve: (event: Record<string, unknown>) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];
    const harness: SocketHarness = {
      socket,
      events,
      waitFor: (predicate, timeoutMs = 5000) => {
        const existing = events.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((waitResolve, waitReject) => {
          const waiter = {
            predicate,
            resolve: (event: Record<string, unknown>) => {
              clearTimeout(waiter.timer);
              waitResolve(event);
            },
            timer: setTimeout(() => {
              waiters.splice(waiters.indexOf(waiter), 1);
              waitReject(new Error("timed out waiting for test websocket event"));
            }, timeoutMs),
          };
          waiters.push(waiter);
        });
      },
    };
    socket.on("open", () => socket.send(JSON.stringify({ type: "hello", userId })));
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

test("Platform passes cumulative context to Agents in group order", async () => {
  const store = new Store();
  const server = new PlatformServer(store);
  let agentA: SocketHarness | undefined;
  let agentB: SocketHarness | undefined;
  let user: SocketHarness | undefined;
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
    user = await connectUser(port, ownerA.id);

    await postJson(`http://127.0.0.1:${port}/api/groups/group-a/messages`, {
      senderType: "human",
      senderId: ownerA.id,
      content: "@agent-a Please analyze this",
    });
    const firstForA = await agentA.waitFor((event) => event.type === "message" && event.content === "@agent-a Please analyze this");
    const replyingA = await user.waitFor((event) => event.type === "pipeline.status" && (event.currentAgent as Record<string, unknown>)?.id === "agent-a");
    assert.equal(replyingA.state, "replying");
    assert.equal((replyingA.agents as Array<Record<string, unknown>>)[0]?.status, "replying");
    assert.equal((firstForA.deliveryContext as Record<string, unknown>).pipeline && ((firstForA.deliveryContext as Record<string, unknown>).pipeline as Record<string, unknown>).step, 1);
    assert.match(String(firstForA.contentForAgent), /Mention State: DIRECT/);
    assert.equal(agentB.events.some((event) => event.type === "message" && event.content === "@agent-a Please analyze this"), false);

    agentA.socket.send(JSON.stringify({
      type: "agent.message",
      clientMessageId: "reply-1",
      groupId: "group-a",
      content: "Agent A reply",
      parentMessageId: firstForA.messageId,
      rootMessageId: firstForA.rootMessageId,
      depth: 1,
    }));
    const accepted = await agentA.waitFor((event) => event.type === "message.accepted" && event.clientMessageId === "reply-1");
    assert.equal(accepted.groupId, "group-a");
    assert.equal(typeof accepted.messageId, "string");
    agentA.socket.send(JSON.stringify({ type: "ack", groupId: "group-a", seq: 1 }));

    const secondForB = await agentB.waitFor((event) => event.type === "message" && event.content === "Agent A reply");
    const replyingB = await user.waitFor((event) => event.type === "pipeline.status" && (event.currentAgent as Record<string, unknown>)?.id === "agent-b");
    assert.equal(replyingB.state, "replying");
    assert.equal((replyingB.agents as Array<Record<string, unknown>>)[0]?.status, "replied");
    assert.equal((replyingB.agents as Array<Record<string, unknown>>)[1]?.status, "replying");
    const secondPipeline = (secondForB.deliveryContext as Record<string, unknown>).pipeline as Record<string, unknown>;
    assert.equal(secondPipeline.step, 2);
    assert.equal(secondPipeline.totalSteps, 2);
    assert.match(String(secondForB.contentForAgent), /Please analyze this/);
    assert.match(String(secondForB.contentForAgent), /Agent A reply/);
    assert.match(String(secondForB.contentForAgent), /exactly NO_REPLY/);
    assert.equal(secondForB.sender && (secondForB.sender as Record<string, unknown>).id, "agent-a");
    agentB.socket.send(JSON.stringify({ type: "ack", groupId: "group-a", seq: 2 }));
    const completed = await user.waitFor((event) => event.type === "pipeline.status" && event.state === "completed" && event.turnId === replyingB.turnId);
    assert.equal((completed.agents as Array<Record<string, unknown>>)[0]?.status, "replied");
    assert.equal((completed.agents as Array<Record<string, unknown>>)[1]?.status, "skipped");

    await postJson(`http://127.0.0.1:${port}/api/groups/group-a/messages`, {
      senderType: "human",
      senderId: ownerA.id,
      content: "@agent-a Second turn",
    });
    const secondTurnForA = await agentA.waitFor((event) => event.type === "message" && event.content === "@agent-a Second turn");
    assert.match(String(secondTurnForA.contentForAgent), /Mention State: DIRECT/);
    agentA.socket.send(JSON.stringify({ type: "ack", groupId: "group-a", seq: 3 }));
    const secondTurnForB = await agentB.waitFor((event) => event.type === "message" && event.content === "@agent-a Second turn");
    assert.match(String(secondTurnForB.contentForAgent), /Mention State: OTHER/);
    agentB.socket.send(JSON.stringify({ type: "ack", groupId: "group-a", seq: 3 }));

    await postJson(`http://127.0.0.1:${port}/api/groups/group-b/messages`, {
      senderType: "human",
      senderId: ownerB.id,
      content: "Beta-only message",
    });
    const betaForA = await agentA.waitFor((event) => event.type === "message" && event.content === "Beta-only message");
    assert.equal((betaForA.group as Record<string, unknown>).id, "group-b");
    agentA.socket.send(JSON.stringify({ type: "ack", groupId: "group-b", seq: 1 }));
    assert.equal(agentB.events.some((event) => event.type === "message" && event.content === "Beta-only message"), false);
  } finally {
    if (user) await closeSocket(user.socket);
    if (agentA) await closeSocket(agentA.socket);
    if (agentB) await closeSocket(agentB.socket);
    await server.stop().catch(() => undefined);
  }
});
