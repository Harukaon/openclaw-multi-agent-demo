#!/usr/bin/env node
import assert from "node:assert/strict";

const baseUrl = (process.argv[2] || "http://127.0.0.1:18788").replace(/\/$/, "");
const adminToken = process.env.PLATFORM_ADMIN_TOKEN;

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

function waitFor(events, predicate, label = "event", timeoutMs = 5000) {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const seen = events.map((event) => `${event.type}:${event.content || ""}`).join(",");
      reject(new Error(`timed out waiting for ${label}; seen=${seen}`));
    }, timeoutMs);
    const onEvent = (event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      resolve(event);
    };
    events.waiters.push(onEvent);
  });
}

function connectAgent(agentId, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws/agent`);
    const events = [];
    events.waiters = [];
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", agentId, token })));
    socket.addEventListener("message", (message) => {
      const event = JSON.parse(String(message.data));
      events.push(event);
      for (const waiter of [...events.waiters]) waiter(event);
      if (event.type === "hello.ok") resolve({ socket, events });
    });
    socket.addEventListener("error", () => reject(new Error("agent websocket failed")));
  });
}

function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
    socket.close();
  });
}

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const ownerA = (await post("/api/users", { username: `smoke-a-${suffix}`, displayName: "Smoke Owner A" })).user;
const ownerB = (await post("/api/users", { username: `smoke-b-${suffix}`, displayName: "Smoke Owner B" })).user;
const createdA = await post("/api/agents", { displayName: `Smoke Agent A ${suffix}` });
const createdB = await post("/api/agents", { displayName: `Smoke Agent B ${suffix}` });
const groupA = (await post("/api/groups", { name: `Smoke Group A ${suffix}`, ownerId: ownerA.id })).group;
const groupB = (await post("/api/groups", { name: `Smoke Group B ${suffix}`, ownerId: ownerB.id })).group;
await post(`/api/groups/${groupA.id}/members`, { actorId: ownerA.id, memberType: "agent", memberId: createdA.agent.id });
await post(`/api/groups/${groupA.id}/members`, { actorId: ownerA.id, memberType: "agent", memberId: createdB.agent.id });
await post(`/api/groups/${groupB.id}/members`, { actorId: ownerB.id, memberType: "agent", memberId: createdA.agent.id });

let agentA;
let agentB;
try {
  agentA = await connectAgent(createdA.agent.id, createdA.token);
  agentB = await connectAgent(createdB.agent.id, createdB.token);
  await post(`/api/groups/${groupA.id}/messages`, { senderType: "human", senderId: ownerA.id, content: "smoke-alpha" });
  await post(`/api/groups/${groupB.id}/messages`, { senderType: "human", senderId: ownerB.id, content: "smoke-beta" });
  await waitFor(agentA.events, (event) => event.type === "message" && event.content === "smoke-alpha", "Agent A alpha");
  await waitFor(agentA.events, (event) => event.type === "message" && event.content === "smoke-beta", "Agent A beta");
  await waitFor(agentB.events, (event) => event.type === "message" && event.content === "smoke-alpha", "Agent B alpha");
  assert.equal(agentB.events.some((event) => event.type === "message" && event.content === "smoke-beta"), false);

  agentA.socket.send(JSON.stringify({ type: "ack", groupId: groupA.id, seq: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await closeSocket(agentA.socket);
  agentA = await connectAgent(createdA.agent.id, createdA.token);
  const replayBeta = await waitFor(agentA.events, (event) => event.type === "message" && event.content === "smoke-beta", "replayed beta");
  assert.equal(agentA.events.some((event) => event.type === "message" && event.content === "smoke-alpha"), false);
  assert.equal(replayBeta.group.id, groupB.id);
  console.log("platform smoke: PASS (membership routing + per-group ACK replay)");
} finally {
  if (agentA) await closeSocket(agentA.socket);
  if (agentB) await closeSocket(agentB.socket);
}
