const PLATFORM_ORIGIN = "https://groupchat-test.feedmob.it.com";
const PLATFORM_WS = PLATFORM_ORIGIN.replace(/^http/, "ws");

const loginGate = document.querySelector("#login-gate");
const loginForm = document.querySelector("#login-form");
const loginUsernameInput = document.querySelector("#login-username");
const loginFeedback = document.querySelector("#login-feedback");
const currentUserNameEl = document.querySelector("#current-user-name");
const logoutButton = document.querySelector("#logout");
const groupList = document.querySelector("#group-list");
const refreshButton = document.querySelector("#refresh");
const connectButton = document.querySelector("#connect");
const statusEl = document.querySelector("#status");
const statusDot = document.querySelector("#status-dot");
const sidebarStatus = document.querySelector("#sidebar-status");
const titleEl = document.querySelector("#group-title");
const subtitleEl = document.querySelector("#group-subtitle");
const broadcastStatusEl = document.querySelector("#broadcast-status");
const broadcastStatusTitleEl = document.querySelector("#broadcast-status-title");
const broadcastStatusDetailEl = document.querySelector("#broadcast-status-detail");
const broadcastAgentsEl = document.querySelector("#broadcast-agents");
const messagesEl = document.querySelector("#messages");
const membersEl = document.querySelector("#members");
const memberCountEl = document.querySelector("#member-count");
const mentionBar = document.querySelector("#mention-bar");
const groupCreateForm = document.querySelector("#group-create-form");
const groupNameInput = document.querySelector("#group-name");
const humanInviteForm = document.querySelector("#human-invite-form");
const humanUsernameInput = document.querySelector("#human-username");
const agentInviteForm = document.querySelector("#agent-invite-form");
const agentSelect = document.querySelector("#agent-select");
const manageFeedback = document.querySelector("#manage-feedback");
const composer = document.querySelector("#composer");
const contentInput = document.querySelector("#content");
const sendButton = composer.querySelector("button");

let socket;
let currentUserId = "";
let currentUser = null;
let groups = [];
let members = [];
let agents = [];
let messages = [];
let selectedGroupId = "";
let activeGroup = null;
let broadcastStatuses = new Map();

function setStatus(text, online = false) {
  statusEl.textContent = text;
  sidebarStatus.textContent = text;
  statusDot.classList.toggle("online", online);
  document.querySelector(".connection-dot").classList.toggle("online", online);
}

const broadcastAgentLabels = {
  waiting: "等待中",
  replying: "回复中",
  replied: "已回复",
  no_reply: "未回复",
  limit: "已达上限",
  offline: "离线",
  timeout: "超时",
};

function renderBroadcastStatus() {
  const status = broadcastStatuses.get(selectedGroupId);
  if (!status || !activeGroup || status.group?.id !== activeGroup.id) {
    broadcastStatusEl.className = "broadcast-status idle";
    broadcastStatusTitleEl.textContent = "等待消息";
    broadcastStatusDetailEl.textContent = "发送消息后，这里会显示 Agent 广播状态";
    broadcastAgentsEl.replaceChildren();
    return;
  }

  broadcastStatusEl.className = `broadcast-status ${status.state}`;
  const replyBudget = `${status.agentReplyCount}/${status.maxAgentReplies}`;
  if (status.state === "completed") {
    broadcastStatusTitleEl.textContent = "本轮广播已完成";
    broadcastStatusDetailEl.textContent = `可见回复 ${replyBudget}`;
  } else if (status.activeAgents?.length) {
    const names = status.activeAgents.map((agent) => agent.displayName).join("、");
    broadcastStatusTitleEl.textContent = `${names} 回复中`;
    broadcastStatusDetailEl.textContent = `并行广播 · 可见回复 ${replyBudget}`;
  } else {
    broadcastStatusTitleEl.textContent = "等待 Agent 决策";
    broadcastStatusDetailEl.textContent = `可见回复 ${replyBudget}`;
  }

  broadcastAgentsEl.replaceChildren();
  for (const agent of status.agents || []) {
    const chip = document.createElement("span");
    chip.className = `broadcast-agent ${agent.status}`;
    const name = document.createElement("b");
    name.textContent = agent.displayName;
    const state = document.createElement("span");
    state.textContent = broadcastAgentLabels[agent.status] || agent.status;
    chip.append(name, state);
    broadcastAgentsEl.append(chip);
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${PLATFORM_ORIGIN}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(currentUserId ? { "x-user-id": currentUserId } : {}),
      ...(options.headers || {}),
    },
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function renderInlineMarkdown(value) {
  const tokens = [];
  const stash = (html) => {
    const token = `@@FEEDMOBMD${tokens.length}@@`;
    tokens.push(html);
    return token;
  };
  let text = String(value);
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => stash(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\[([^]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/gi, (_match, label, url) => (
    stash(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`)
  ));
  text = escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>");
  return text.replace(/@@FEEDMOBMD(\d+)@@/g, (_match, index) => tokens[Number(index)] || "");
}

function renderMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${renderInlineMarkdown(paragraph.join("\n"))}</p>`);
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*```([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
      output.push(`<pre><code${language}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(---+|\*\s*\*\s*\*)\s*$/.test(line)) {
      flushParagraph();
      output.push("<hr>");
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      index -= 1;
      output.push(`<blockquote>${renderInlineMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-*+]\s+(.+)$/);
        if (!item) break;
        items.push(`<li>${renderInlineMarkdown(item[1])}</li>`);
        index += 1;
      }
      index -= 1;
      output.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(`<li>${renderInlineMarkdown(item[1])}</li>`);
        index += 1;
      }
      index -= 1;
      output.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return output.join("");
}

const explicitAgentColors = { "agent-a": 0, "agent-b": 1, "agent-c": 2 };
function agentColorClass(agentId) {
  if (explicitAgentColors[agentId] !== undefined) return `agent-color-${explicitAgentColors[agentId]}`;
  let hash = 0;
  for (const character of String(agentId)) hash = ((hash << 5) - hash) + character.charCodeAt(0);
  return `agent-color-${Math.abs(hash) % 6}`;
}

function renderMessages() {
  messagesEl.replaceChildren();
  if (!messages.length) {
    showEmpty();
    return;
  }
  for (const message of messages) {
    const item = document.createElement("article");
    const isAgent = message.sender.type === "agent";
    const speakerClass = isAgent ? "agent" : (message.sender.id === currentUserId ? "own" : "other");
    const colorClass = isAgent ? agentColorClass(message.sender.id) : "";
    item.className = `message ${message.sender.type} ${speakerClass} ${colorClass}`;
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const senderName = document.createElement("span");
    senderName.className = "message-sender";
    senderName.textContent = message.sender.name;
    const sequence = document.createElement("span");
    sequence.className = "message-seq";
    sequence.textContent = `#${message.seq}`;
    meta.append(senderName, sequence);
    const body = document.createElement("div");
    body.className = "message-body markdown-body";
    body.innerHTML = renderMarkdown(message.content);
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
    const broadcast = broadcastStatuses.get(group.id);
    if (broadcast?.state === "broadcasting" && broadcast.activeAgents?.length) {
      const replying = document.createElement("span");
      replying.className = "group-broadcast-badge replying";
      replying.textContent = broadcast.activeAgents.map((agent) => agent.displayName).join("、");
      button.append(replying);
    } else if (broadcast?.state === "completed") {
      const completed = document.createElement("span");
      completed.className = "group-broadcast-badge completed";
      completed.textContent = "完成";
      button.append(completed);
    }
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
  const canManage = Boolean(activeGroup && activeGroup.ownerId === currentUserId);
  agentSelect.disabled = !canManage || !available.length;
  agentInviteForm.querySelector("button").disabled = !canManage || !available.length;
  humanUsernameInput.disabled = !canManage;
  humanInviteForm.querySelector("button").disabled = !canManage;
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
    const colorClass = member.memberType === "agent" ? agentColorClass(member.memberId) : "";
    avatar.className = `avatar ${member.memberType} ${colorClass}`;
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
  if (agents.length) {
    const allChip = document.createElement("button");
    allChip.type = "button";
    allChip.className = "mention-chip mention-all";
    allChip.textContent = "@all";
    allChip.title = "提及群内全部成员";
    allChip.addEventListener("click", () => {
      contentInput.value = `${contentInput.value}${contentInput.value ? " " : ""}@all `;
      contentInput.focus();
    });
    mentionBar.append(allChip);
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

function resetWorkspace() {
  groups = [];
  members = [];
  messages = [];
  activeGroup = null;
  selectedGroupId = "";
  broadcastStatuses = new Map();
  renderGroups();
  renderBroadcastStatus();
  renderMembers();
  titleEl.textContent = "选择一个群组";
  subtitleEl.textContent = "输入用户名后开始群聊";
  contentInput.disabled = true;
  sendButton.disabled = true;
  refreshButton.disabled = true;
  groupCreateForm.querySelector("button").disabled = true;
  humanInviteForm.querySelector("button").disabled = true;
  humanUsernameInput.disabled = true;
}

async function login(username) {
  loginFeedback.textContent = "正在进入…";
  try {
    const payload = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username }),
    });
    currentUser = payload.user;
    currentUserId = currentUser.id;
    currentUserNameEl.textContent = `${currentUser.displayName}（${currentUser.username}）`;
    loginGate.hidden = true;
    loginFeedback.textContent = "";
    connectButton.disabled = false;
    groupCreateForm.querySelector("button").disabled = false;
    await loadAgents();
    connect();
  } catch (error) {
    loginFeedback.textContent = `无法进入：${error.message}`;
  }
}

function logout() {
  socket?.close();
  socket = undefined;
  currentUser = null;
  currentUserId = "";
  resetWorkspace();
  currentUserNameEl.textContent = "未登录";
  setStatus("请先输入用户名");
  loginGate.hidden = false;
  loginUsernameInput.value = "";
  loginFeedback.textContent = "";
  loginUsernameInput.focus();
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
  renderBroadcastStatus();
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
    renderBroadcastStatus();
    contentInput.disabled = !socket || socket.readyState !== WebSocket.OPEN || group.status === "paused";
    sendButton.disabled = contentInput.disabled;
  } catch (error) {
    showEmpty(`无法加载群组：${error.message}`);
  }
}

function connect() {
  if (!currentUserId) return;
  const userIdForSocket = currentUserId;
  socket?.close();
  setStatus("连接中…");
  const userSocket = new WebSocket(`${PLATFORM_WS}/ws/user`);
  socket = userSocket;
  userSocket.addEventListener("open", () => {
    if (currentUserId === userIdForSocket) userSocket.send(JSON.stringify({ type: "hello", userId: userIdForSocket }));
  });
  userSocket.addEventListener("message", (event) => {
    if (socket !== userSocket || currentUserId !== userIdForSocket) return;
    const payload = JSON.parse(event.data);
    if (payload.type === "hello.ok") {
      setStatus("已连接", true);
      groups = payload.groups || [];
      broadcastStatuses = new Map((payload.broadcastStatuses || []).map((status) => [status.group?.id, status]));
      if (!groups.some((group) => group.id === selectedGroupId)) selectedGroupId = groups[0]?.id || "";
      renderGroups();
      if (selectedGroupId) void selectGroup(selectedGroupId);
      else {
        renderBroadcastStatus();
        showEmpty("当前用户没有群组");
      }
      renderBroadcastStatus();
      connectButton.textContent = "重连";
      refreshButton.disabled = false;
      return;
    }
    if (payload.type === "groups.updated") {
      groups = payload.groups || [];
      if (selectedGroupId && !groups.some((group) => group.id === selectedGroupId)) {
        selectedGroupId = "";
        activeGroup = null;
        members = [];
        messages = [];
        renderMembers();
        renderMessages();
        renderBroadcastStatus();
        titleEl.textContent = "选择一个群组";
        subtitleEl.textContent = "你已不再是该群组成员";
      }
      renderGroups();
      if (!selectedGroupId && groups[0]) void selectGroup(groups[0].id);
      return;
    }
    if (payload.type === "message") {
      if (payload.group?.id !== selectedGroupId || messages.some((message) => message.messageId === payload.messageId || message.id === payload.messageId)) return;
      messages.push(payload);
      renderMessages();
      return;
    }
    if (payload.type === "broadcast.status") {
      broadcastStatuses.set(payload.group?.id, payload);
      renderGroups();
      renderBroadcastStatus();
      return;
    }
    if (payload.type === "error") setStatus(`错误：${payload.message}`);
  });
  userSocket.addEventListener("close", () => {
    if (socket !== userSocket || currentUserId !== userIdForSocket) return;
    setStatus("已断开");
    contentInput.disabled = true;
    sendButton.disabled = true;
  });
  userSocket.addEventListener("error", () => {
    if (socket === userSocket && currentUserId === userIdForSocket) setStatus("连接失败");
  });
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
humanInviteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = humanUsernameInput.value.trim();
  if (!activeGroup || !username || activeGroup.ownerId !== currentUserId) return;
  const button = humanInviteForm.querySelector("button");
  button.disabled = true;
  try {
    const loginPayload = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username }),
    });
    const payload = await api(`/api/groups/${encodeURIComponent(activeGroup.id)}/members`, {
      method: "POST",
      body: JSON.stringify({ actorId: currentUserId, memberType: "human", memberId: loginPayload.user.id }),
    });
    members = payload.members || members;
    humanUsernameInput.value = "";
    renderMembers();
    renderAgentChoices();
    setManageFeedback(`已邀请 ${loginPayload.user.displayName}`);
  } catch (error) {
    setManageFeedback(`邀请成员失败：${error.message}`, true);
  } finally {
    renderAgentChoices();
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
logoutButton.addEventListener("click", logout);
refreshButton.addEventListener("click", () => connect());
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const content = contentInput.value.trim();
  if (!content || !selectedGroupId || !socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "user.message", groupId: selectedGroupId, content }));
  contentInput.value = "";
});
loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const username = loginUsernameInput.value.trim();
  if (username) void login(username);
});
window.addEventListener("beforeunload", () => socket?.close());
resetWorkspace();
setStatus("请先输入用户名");
loginUsernameInput.focus();
