import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { Store } from "../src/store.js";
import { PlatformServer } from "../src/server.js";
import { buildAgentContentForAgent } from "../src/agent-prompt.js";
import { mentionStateFor } from "../src/mention.js";

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

    const all = store.appendMessage({
      groupId: groupA.id,
      sender: { type: "human", id: ownerA.id, name: ownerA.displayName },
      content: "@all reply once",
    });
    assert.deepEqual(all.mentions.filter((item) => item.type === "agent").map((item) => item.id), ["agent-a", "agent-b"]);
    assert.equal(all.mentions.some((item) => item.type === "human" && item.id === ownerA.id), true);
    assert.equal(mentionStateFor("human", ownerA.id, agentA.agent.id, all.mentions), "DIRECT");
    assert.equal(mentionStateFor("human", ownerA.id, agentB.agent.id, all.mentions), "DIRECT");
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
  assert.match(direct, /你的身份是：Agent A（agent-a）/);
  assert.match(direct, /Mention State: DIRECT/);
  assert.match(direct, /直接 @ 了你/);
  assert.match(direct, /Please review this/);

  const other = buildAgentContentForAgent({ ...base, mentionState: "OTHER" });
  assert.match(other, /Mention State: OTHER/);
  assert.match(other, /指向其他群成员或 Agent/);

  const none = buildAgentContentForAgent({ ...base, mentionState: "NONE" });
  assert.match(none, /Mention State: NONE/);
  assert.match(none, /本消息没有 @ 你/);
  assert.match(none, /没有 @ 任何群成员/);

  const self = buildAgentContentForAgent({ ...base, mentionState: "SELF" });
  assert.match(self, /Mention State: SELF/);
  assert.match(self, /由你自己发出/);
});

test("username login is stable and group details stay private to members", async () => {
  const store = new Store();
  const server = new PlatformServer(store);
  try {
    await server.listen(0, "127.0.0.1");
    const address = server.httpServer.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const login = async (username: string) => {
      const response = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).user as { id: string; username: string; displayName: string };
    };
    const leo = await login("Leo");
    const sameLeo = await login("leo");
    const wendy = await login("Wendy");
    assert.equal(sameLeo.id, leo.id);
    assert.equal(leo.username, "leo");
    assert.equal(leo.displayName, "Leo");

    const groupResponse = await fetch(`${base}/api/groups`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": leo.id },
      body: JSON.stringify({ name: "Leo private group", ownerId: leo.id }),
    });
    assert.equal(groupResponse.status, 201);
    const group = (await groupResponse.json()).group as { id: string };
    const posted = await fetch(`${base}/api/groups/${group.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": leo.id },
      body: JSON.stringify({ senderType: "human", senderId: leo.id, content: "private **note**" }),
    });
    assert.equal(posted.status, 201);
    const postedMessage = (await posted.json()).message as { sender: { name: string } };
    assert.equal(postedMessage.sender.name, "Leo");

    const visible = await fetch(`${base}/api/groups/${group.id}`, { headers: { "x-user-id": leo.id } });
    assert.equal(visible.status, 200);
    const hidden = await fetch(`${base}/api/groups/${group.id}`, { headers: { "x-user-id": wendy.id } });
    assert.equal(hidden.status, 404);
    const hiddenMessages = await fetch(`${base}/api/groups/${group.id}/messages`, { headers: { "x-user-id": wendy.id } });
    assert.equal(hiddenMessages.status, 404);
  } finally {
    await server.stop().catch(() => undefined);
  }
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

test("Platform broadcasts live context with loop and group isolation guards", async () => {
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
    store.appendMessage({
      groupId: groupA.id,
      sender: { type: "human", id: ownerA.id, name: ownerA.displayName },
      content: "Earlier human turn: Agent A already answered pong",
    });

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
    const firstForB = await agentB.waitFor((event) => event.type === "message" && event.content === "@agent-a Please analyze this");
    const broadcasting = await user.waitFor((event) => event.type === "broadcast.status" && event.state === "broadcasting");
    assert.deepEqual((broadcasting.activeAgents as Array<Record<string, unknown>>).map((agent) => agent.id).sort(), ["agent-a", "agent-b"]);
    assert.equal((firstForA.deliveryContext as Record<string, unknown>).broadcast !== undefined, true);
    assert.equal((firstForB.deliveryContext as Record<string, unknown>).broadcast !== undefined, true);
    assert.match(String(firstForA.contentForAgent), /Mention State: DIRECT/);
    assert.match(String(firstForB.contentForAgent), /Mention State: OTHER/);
    assert.match(String(firstForB.contentForAgent), /Visible Agent replies so far: 0\/12/);
    assert.match(String(firstForB.contentForAgent), /Earlier human turn: Agent A already answered pong/);
    agentA.socket.send(JSON.stringify({ type: "ack", groupId: "group-a", seq: firstForA.seq, messageId: firstForA.messageId }));
    agentB.socket.send(JSON.stringify({ type: "ack", groupId: "group-a", seq: firstForB.seq, messageId: firstForB.messageId }));

    agentA.socket.send(JSON.stringify({
      type: "agent.message",
      clientMessageId: "reply-a",
      groupId: "group-a",
      content: "Agent A reply",
      parentMessageId: firstForA.messageId,
      rootMessageId: firstForA.rootMessageId,
      depth: 1,
    }));
    const acceptedA = await agentA.waitFor((event) => event.type === "message.accepted" && event.clientMessageId === "reply-a");
    assert.equal(acceptedA.groupId, "group-a");
    const fromAForB = await agentB.waitFor((event) => event.type === "message" && event.content === "Agent A reply");
    assert.equal(agentA.events.some((event) => event.type === "message" && event.content === "Agent A reply"), false);
    assert.equal((fromAForB.sender as Record<string, unknown>).id, "agent-a");
    assert.equal((fromAForB.deliveryContext as Record<string, unknown>).observation, true);
    assert.match(String(fromAForB.contentForAgent), /@agent-a Please analyze this/);
    assert.match(String(fromAForB.contentForAgent), /Agent A reply/);

    agentB.socket.send(JSON.stringify({
      type: "agent.message",
      clientMessageId: "reply-b",
      groupId: "group-a",
      content: "Agent B reply",
      parentMessageId: firstForB.messageId,
      rootMessageId: firstForB.rootMessageId,
      depth: 1,
    }));
    await agentB.waitFor((event) => event.type === "message.accepted" && event.clientMessageId === "reply-b");
    const fromBForA = await agentA.waitFor((event) => event.type === "message" && event.content === "Agent B reply");
    assert.equal((fromBForA.sender as Record<string, unknown>).id, "agent-b");
    assert.equal((fromBForA.deliveryContext as Record<string, unknown>).observation, true);
    assert.match(String(fromBForA.contentForAgent), /@agent-a Please analyze this/);
    assert.match(String(fromBForA.contentForAgent), /Agent A reply/);
    assert.match(String(fromBForA.contentForAgent), /Visible Agent replies so far: 2\/12/);
    agentB.socket.send(JSON.stringify({ type: "ack", groupId: "group-a", seq: fromAForB.seq, messageId: fromAForB.messageId }));
    agentA.socket.send(JSON.stringify({ type: "ack", groupId: "group-a", seq: fromBForA.seq, messageId: fromBForA.messageId }));

    const completed = await user.waitFor((event) => event.type === "broadcast.status" && event.state === "completed", 7000);
    assert.equal(completed.agentReplyCount, 2);
    assert.deepEqual((completed.agents as Array<Record<string, unknown>>).map((agent) => agent.status).sort(), ["replied", "replied"]);

    await postJson(`http://127.0.0.1:${port}/api/groups/group-b/messages`, {
      senderType: "human",
      senderId: ownerB.id,
      content: "Beta-only message",
    });
    const betaForA = await agentA.waitFor((event) => event.type === "message" && event.content === "Beta-only message");
    assert.equal((betaForA.group as Record<string, unknown>).id, "group-b");
    agentA.socket.send(JSON.stringify({ type: "ack", groupId: "group-b", seq: betaForA.seq, messageId: betaForA.messageId }));
    assert.equal(agentB.events.some((event) => event.type === "message" && event.content === "Beta-only message"), false);
  } finally {
    if (user) await closeSocket(user.socket);
    if (agentA) await closeSocket(agentA.socket);
    if (agentB) await closeSocket(agentB.socket);
    await server.stop().catch(() => undefined);
  }
});


test("Platform suppresses Agent replies after the per-root broadcast budget", async () => {
  const store = new Store();
  const server = new PlatformServer(store);
  let agentSocket: SocketHarness | undefined;
  try {
    const owner = store.createUser({ id: "budget-owner", username: "budget-owner", displayName: "Budget Owner" });
    const created = store.createAgent({ id: "budget-agent", displayName: "Budget Agent" });
    const group = store.createGroup({ id: "budget-group", name: "Budget Group", ownerId: owner.id });
    store.addMember({ groupId: group.id, memberType: "agent", memberId: created.agent.id });
    await server.listen(0, "127.0.0.1");
    const address = server.httpServer.address();
    assert.ok(address && typeof address === "object");
    agentSocket = await connectAgent(address.port, created.agent.id, created.token);
    await postJson(`http://127.0.0.1:${address.port}/api/groups/${group.id}/messages`, {
      senderType: "human",
      senderId: owner.id,
      content: "Start bounded broadcast",
    });
    const root = await agentSocket.waitFor((event) => event.type === "message" && event.content === "Start bounded broadcast");
    agentSocket.socket.send(JSON.stringify({ type: "ack", groupId: group.id, seq: root.seq, messageId: root.messageId }));
    const rootMessageId = String(root.rootMessageId || root.messageId);

    for (let index = 1; index <= 12; index += 1) {
      agentSocket.socket.send(JSON.stringify({
        type: "agent.message",
        clientMessageId: `budget-${index}`,
        groupId: group.id,
        content: `reply-${index}`,
        parentMessageId: root.messageId,
        rootMessageId,
        depth: 1,
      }));
      await agentSocket.waitFor((event) => event.type === "message.accepted" && event.clientMessageId === `budget-${index}`);
    }
    agentSocket.socket.send(JSON.stringify({
      type: "agent.message",
      clientMessageId: "budget-13",
      groupId: group.id,
      content: "reply-13",
      parentMessageId: root.messageId,
      rootMessageId,
      depth: 1,
    }));
    const suppressed = await agentSocket.waitFor((event) => event.type === "message.suppressed" && event.clientMessageId === "budget-13");
    assert.equal(suppressed.reason, "max_agent_replies");
    assert.equal(store.getMessages(group.id).length, 13);
  } finally {
    if (agentSocket) await closeSocket(agentSocket.socket);
    await server.stop().catch(() => undefined);
  }
});
