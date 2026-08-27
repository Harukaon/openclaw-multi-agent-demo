const PLATFORM_ORIGIN = "https://groupchat-test.feedmob.it.com";
const PLATFORM_WS = PLATFORM_ORIGIN.replace(/^http/, "ws");

const userSelect = document.querySelector("#user-select");
const groupList = document.querySelector("#group-list");
const refreshButton = document.querySelector("#refresh");
const connectButton = document.querySelector("#connect");
const statusEl = document.querySelector("#status");
const statusDot = document.querySelector("#status-dot");
const sidebarStatus = document.querySelector("#sidebar-status");
const titleEl = document.querySelector("#group-title");
const subtitleEl = document.querySelector("#group-subtitle");
const messagesEl = document.querySelector("#messages");
const membersEl = document.querySelector("#members");
const memberCountEl = document.querySelector("#member-count");
const mentionBar = document.querySelector("#mention-bar");
const groupCreateForm = document.querySelector("#group-create-form");
const groupNameInput = document.querySelector("#group-name");
const agentInviteForm = document.querySelector("#agent-invite-form");
const agentSelect = document.querySelector("#agent-select");
const manageFeedback = document.querySelector("#manage-feedback");
const composer = document.querySelector("#composer");
const contentInput = document.querySelector("#content");
const sendButton = composer.querySelector("button");

let socket;
let currentUserId = new URLSearchParams(window.location.search).get("user") || "";
let groups = [];
let members = [];
let agents = [];
let messages = [];
let selectedGroupId = "";
let activeGroup = null;

function setStatus(text, online = false) {
  statusEl.textContent = text;
  sidebarStatus.textContent = text;
  statusDot.classList.toggle("online", online);
  document.querySelector(".connection-dot").classList.toggle("online", online);
}

async function api(path, options = {}) {
  const response = await fetch(`${PLATFORM_ORIGIN}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  return payload;
}

function showEmpty(text = "暂无消息") {
  messagesEl.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = text;
  messagesEl.append(empty);
}

function renderMessages() {
  messagesEl.replaceChildren();
  if (!messages.length) {
    showEmpty();
    return;
  }
  for (const message of messages) {
    const item = document.createElement("article");
    item.className = `message ${message.sender.type}`;
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = `${message.sender.name} · #${message.seq}`;
    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = message.content;
    item.append(meta, body);
    messagesEl.append(item);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderGroups() {
  groupList.replaceChildren();
  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "empty sidebar-empty";
    empty.textContent = "暂无群组";
    groupList.append(empty);
    return;
  }
  for (const group of groups) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `group-item${group.id === selectedGroupId ? " active" : ""}`;
    button.dataset.groupId = group.id;
    const hash = document.createElement("span");
    hash.className = "hash";
    hash.textContent = "#";
    const name = document.createElement("span");
    name.className = "group-name";
    name.textContent = group.name;
    button.append(hash, name);
    if (group.status === "paused") {
      const paused = document.createElement("span");
      paused.className = "paused";
      paused.textContent = "暂停";
      button.append(paused);
    }
    button.addEventListener("click", () => void selectGroup(group.id));
    groupList.append(button);
  }
}

function setManageFeedback(text = "", isError = false) {
  manageFeedback.textContent = text;
  manageFeedback.classList.toggle("error", isError);
}

function renderAgentChoices() {
  const memberIds = new Set(members.filter((member) => member.memberType === "agent").map((member) => member.memberId));
  const available = agents.filter((agent) => !memberIds.has(agent.id));
  agentSelect.replaceChildren();
  if (!available.length) {
    const option = document.createElement("option");
    option.textContent = agents.length ? "所有 Agent 已在群内" : "暂无可用 Agent";
    agentSelect.append(option);
  } else {
    for (const agent of available) {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = `${agent.displayName}${agent.connectionStatus === "online" ? " · 在线" : ""}`;
      agentSelect.append(option);
    }
  }
  const canManage = Boolean(activeGroup && activeGroup.ownerId === currentUserId && available.length);
  agentSelect.disabled = !canManage;
  agentInviteForm.querySelector("button").disabled = !canManage;
}

function renderMembers() {
  membersEl.replaceChildren();
  memberCountEl.textContent = String(members.length || "—");
  mentionBar.replaceChildren();
  const agents = members.filter((member) => member.memberType === "agent");
  for (const member of members) {
    const row = document.createElement("div");
    row.className = "member";
    const avatar = document.createElement("span");
    avatar.className = `avatar ${member.memberType}`;
    avatar.textContent = member.memberType === "agent" ? "AI" : "人";
    const text = document.createElement("div");
    const name = document.createElement("span");
    name.className = "member-name";
    name.textContent = member.displayName;
    const detail = document.createElement("span");
    detail.className = "member-detail";
    detail.textContent = member.memberType === "agent" ? "OpenClaw Agent" : "Human member";
    text.append(name, detail);
    row.append(avatar, text);
    membersEl.append(row);
  }
  for (const agent of agents) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "mention-chip";
    chip.textContent = `@${agent.displayName}`;
    chip.title = `插入 @${agent.memberId}`;
    chip.addEventListener("click", () => {
      contentInput.value = `${contentInput.value}${contentInput.value ? " " : ""}@${agent.memberId} `;
      contentInput.focus();
    });
    mentionBar.append(chip);
  }
  renderAgentChoices();
}

async function loadUsers() {
  try {
    const payload = await api("/api/users");
    userSelect.replaceChildren();
    for (const user of payload.users || []) {
      const option = document.createElement("option");
      option.value = user.id;
      option.textContent = `${user.displayName}（${user.username}）`;
      userSelect.append(option);
    }
    if (!currentUserId || !payload.users.some((user) => user.id === currentUserId)) currentUserId = payload.users[0]?.id || "";
    if (currentUserId) userSelect.value = currentUserId;
    userSelect.disabled = !currentUserId;
    connectButton.disabled = !currentUserId;
    groupCreateForm.querySelector("button").disabled = !currentUserId;
    if (!currentUserId) showEmpty("暂无用户，请先通过 Platform API 创建演示用户");
  } catch (error) {
    setStatus("Platform 不可用");
    showEmpty(`无法连接 Platform：${error.message}`);
  }
}

async function loadAgents() {
  try {
    const payload = await api("/api/agents");
    agents = payload.agents || [];
    renderAgentChoices();
  } catch (error) {
    setManageFeedback(`无法加载 Agent：${error.message}`, true);
  }
}

async function selectGroup(groupId) {
  selectedGroupId = groupId;
  renderGroups();
  const group = groups.find((item) => item.id === groupId);
  activeGroup = group || null;
  renderAgentChoices();
  if (!group) return;
  titleEl.textContent = group.name;
  subtitleEl.textContent = group.status === "paused" ? "群组已暂停" : "实时消息 · WebSocket";
  showEmpty("正在加载消息…");
  try {
    const [messagePayload, groupPayload] = await Promise.all([
      api(`/api/groups/${encodeURIComponent(groupId)}/messages`),
      api(`/api/groups/${encodeURIComponent(groupId)}`),
    ]);
    messages = messagePayload.messages || [];
    members = groupPayload.members || [];
    renderMessages();
    renderMembers();
    contentInput.disabled = !socket || socket.readyState !== WebSocket.OPEN || group.status === "paused";
    sendButton.disabled = contentInput.disabled;
  } catch (error) {
    showEmpty(`无法加载群组：${error.message}`);
  }
}

function connect() {
  currentUserId = userSelect.value;
  if (!currentUserId) return;
  socket?.close();
  setStatus("连接中…");
  socket = new WebSocket(`${PLATFORM_WS}/ws/user`);
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", userId: currentUserId })));
  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "hello.ok") {
      setStatus("已连接", true);
      groups = payload.groups || [];
      if (!groups.some((group) => group.id === selectedGroupId)) selectedGroupId = groups[0]?.id || "";
      renderGroups();
      if (selectedGroupId) void selectGroup(selectedGroupId);
      else showEmpty("当前用户没有群组");
      connectButton.textContent = "重连";
      refreshButton.disabled = false;
      return;
    }
    if (payload.type === "message") {
      if (payload.group?.id !== selectedGroupId || messages.some((message) => message.messageId === payload.messageId || message.id === payload.messageId)) return;
      messages.push(payload);
      renderMessages();
      return;
    }
    if (payload.type === "error") setStatus(`错误：${payload.message}`);
  });
  socket.addEventListener("close", () => {
    setStatus("已断开");
    contentInput.disabled = true;
    sendButton.disabled = true;
  });
  socket.addEventListener("error", () => setStatus("连接失败"));
}

connectButton.addEventListener("click", connect);
groupCreateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = groupNameInput.value.trim();
  if (!name || !currentUserId) return;
  const button = groupCreateForm.querySelector("button");
  button.disabled = true;
  try {
    const payload = await api("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name, ownerId: currentUserId }),
    });
    groups = [payload.group, ...groups.filter((group) => group.id !== payload.group.id)];
    groupNameInput.value = "";
    selectedGroupId = payload.group.id;
    renderGroups();
    setManageFeedback(`已创建群聊「${payload.group.name}」`);
    await selectGroup(payload.group.id);
  } catch (error) {
    setManageFeedback(`创建群聊失败：${error.message}`, true);
  } finally {
    button.disabled = !currentUserId;
  }
});
agentInviteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const agentId = agentSelect.value;
  if (!activeGroup || !agentId || activeGroup.ownerId !== currentUserId) return;
  const button = agentInviteForm.querySelector("button");
  button.disabled = true;
  try {
    const payload = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/members`, {
      method: "POST",
      body: JSON.stringify({ actorId: currentUserId, memberType: "agent", memberId: agentId }),
    });
    members = payload.members || members;
    renderMembers();
    const invited = agents.find((agent) => agent.id === agentId);
    setManageFeedback(`已邀请 ${invited?.displayName || "Agent"} 加入群聊`);
  } catch (error) {
    setManageFeedback(`邀请 Agent 失败：${error.message}`, true);
    renderAgentChoices();
  }
});
userSelect.addEventListener("change", () => {
  currentUserId = userSelect.value;
  groups = [];
  members = [];
  activeGroup = null;
  selectedGroupId = "";
  renderGroups();
  renderMembers();
  setManageFeedback("");
  socket?.close();
  connect();
});
refreshButton.addEventListener("click", () => connect());
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const content = contentInput.value.trim();
  if (!content || !selectedGroupId || !socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "user.message", groupId: selectedGroupId, content }));
  contentInput.value = "";
});
window.addEventListener("beforeunload", () => socket?.close());
void Promise.all([loadUsers(), loadAgents()]);
