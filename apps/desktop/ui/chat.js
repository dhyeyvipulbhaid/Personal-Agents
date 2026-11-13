const defaults = {
  chat: "qwen3:4b",
  agent: "qwen3:8b",
  builder: "qwen2.5-coder:7b",
};

const thread = document.getElementById("thread");
thread?.addEventListener("click", (event) => {
  const link = event.target.closest("a[href]");
  if (!link) {
    return;
  }
  const href = link.href;
  if (!/^https?:\/\//i.test(href)) {
    return;
  }
  event.preventDefault();
  const open = window.pa?.invoke?.("open_link", { url: href });
  if (open && typeof open.catch === "function") {
    open.catch(() => {
      window.open(href, "_blank", "noopener,noreferrer");
    });
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
});
const sessions = document.getElementById("sessions");
const modelError = document.getElementById("model-error");
const modelNotice = document.getElementById("model-notice");
const ollamaDot = document.getElementById("ollama-dot");
const draft = document.getElementById("draft");
const sendButton = document.getElementById("send-button");
const selects = {
  chat: document.getElementById("chat-model"),
  agent: document.getElementById("agent-model"),
  builder: document.getElementById("builder-model"),
};

let activeId = "";
let sending = false;
let round = 0;
let paint = 0;
let optimisticText = "";
let pendingApprovals = [];
let hostWatch = 0;
let savedTimer = 0;
const lockStore = "pa-approval-locks";
const lockedCards = loadLocks();

function loadLocks() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(lockStore) || "{}");
    return new Map(
      Object.entries(parsed).filter(
        (entry) => typeof entry[1] === "string" && entry[0].length > 0,
      ),
    );
  } catch {
    return new Map();
  }
}

function storeLocks() {
  try {
    const stored = {};
    for (const [id, text] of lockedCards) {
      stored[id] = text;
    }
    sessionStorage.setItem(lockStore, JSON.stringify(stored));
  } catch {
    // The in-memory map still locks this page.
  }
}

function normalize(parsed) {
  if (Array.isArray(parsed)) {
    return {
      messages: parsed,
      sessions: [{ id: "this", title: "This chat" }],
      activeId: "this",
      streaming: false,
      pending: [],
      models: null,
      notice: "",
    };
  }
  return {
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    activeId: typeof parsed.activeId === "string" ? parsed.activeId : "",
    streaming: Boolean(parsed.streaming),
    pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    models: parsed.models ?? null,
    notice: typeof parsed.notice === "string" ? parsed.notice : "",
  };
}

function modelName(model) {
  if (typeof model === "string") {
    return model;
  }
  return typeof model?.name === "string" ? model.name : "";
}

function fillSelect(select, models, selected) {
  const known = models.map(modelName).filter((name) => name.length > 0);
  const names = [...known];
  if (selected && !names.includes(selected)) {
    names.unshift(selected);
  }
  select.replaceChildren();
  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = known.includes(name)
      ? name
      : `${name} (not installed)`;
    select.append(option);
  }
  if (
    selected &&
    [...select.options].some((option) => option.value === selected)
  ) {
    select.value = selected;
  }
}

function renderMessages(messages) {
  thread.replaceChildren();
  if (messages.length === 0 && optimisticText.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent =
      "Send a message to the local model. Enter sends. Shift+Enter adds a line.";
    thread.append(empty);
    return;
  }
  for (const message of displayOrder(messages)) {
    if (message.role === "approval") {
      const card = document.createElement("article");
      card.className = "card inline-approval";
      if (message.approvalId) {
        card.dataset.approvalId = message.approvalId;
      }
      const text = document.createElement("p");
      text.textContent = message.text;
      card.append(text);
      if (settled(message.text)) {
        lockedCards.delete(message.approvalId);
        storeLocks();
        const line = document.createElement("p");
        line.className = "muted approval-status";
        line.textContent = settledLine(message.text);
        thread.append(line);
        continue;
      }
      const waiting = document.createElement("p");
      waiting.className = "muted";
      waiting.dataset.waiting = "1";
      waiting.append("Waiting for approval… ");
      const review = document.createElement("a");
      review.href = "approvals.html";
      review.textContent = "Review";
      waiting.append(review);
      card.append(waiting);
      if (lockedCards.has(message.approvalId)) {
        card.dataset.locked = "1";
        const status = document.createElement("p");
        status.className = "muted";
        status.dataset.status = "1";
        status.textContent = lockedCards.get(message.approvalId);
        card.append(status);
      } else if (message.approvalId) {
        card.append(
          decisionButton(
            "Approve",
            message.approvalId,
            "approve",
            message.text,
          ),
          decisionButton("Deny", message.approvalId, "deny", message.text),
        );
      }
      thread.append(card);
      continue;
    }
    if (message.role === "memory") {
      continue;
    }
    const role = message.role === "user" ? "user" : "assistant";
    const visible =
      role === "assistant" ? visibleAnswer(message.text) : (message.text ?? "");
    if (role === "assistant" && visible.length === 0) {
      continue;
    }
    const bubble = document.createElement("div");
    bubble.className = `bubble ${role}`;
    if (role === "assistant") {
      bubble.innerHTML = markdownToHtml(visible);
    } else {
      bubble.textContent = visible;
    }
    thread.append(bubble);
  }
  for (const item of pendingApprovals) {
    if (thread.querySelector(`[data-approval-id="${item.id}"]`)) {
      continue;
    }
    const line = document.createElement("p");
    line.className = "muted";
    line.dataset.waiting = "1";
    line.dataset.approvalId = item.id;
    line.append("Waiting for approval… ");
    const review = document.createElement("a");
    review.href = "approvals.html";
    review.textContent = "Review";
    line.append(review);
    thread.append(line);
  }
  appendThinking(messages);
  thread.scrollTop = thread.scrollHeight;
}

function currentTurn(messages) {
  let start = 0;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role === "user") {
      start = index;
    }
  }
  return messages.slice(start);
}

function visibleAnswer(text) {
  return String(text ?? "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/i, "")
    .replace(/<\/think>/gi, "")
    .trim();
}

function appendThinking(messages) {
  if (!sending) {
    return;
  }
  const turn = currentTurn(messages);
  const pendingCard = turn.some(
    (message) => message.role === "approval" && !settled(message.text),
  );
  if (pendingCard) {
    return;
  }
  let toolAt = -1;
  for (let index = 0; index < turn.length; index += 1) {
    const message = turn[index];
    if (message.role === "approval" && settled(message.text)) {
      toolAt = index;
    }
  }
  const hasAnswer = turn.some(
    (message) =>
      message.role === "assistant" && visibleAnswer(message.text).length > 0,
  );
  if (hasAnswer || (optimisticText.length === 0 && toolAt < 0)) {
    return;
  }
  const echoed = messages.some(
    (message) => message.role === "user" && message.text === optimisticText,
  );
  if (!echoed && optimisticText.length > 0) {
    const user = document.createElement("div");
    user.className = "bubble user";
    user.textContent = optimisticText;
    thread.append(user);
  }
  const thought = document.createElement("div");
  thought.className = "bubble assistant";
  thought.dataset.thinking = "1";
  thought.textContent = toolAt >= 0 ? "Writing answer…" : "Thinking…";
  thread.append(thought);
}

function showPendingThought() {
  appendThinking([]);
  thread.scrollTop = thread.scrollHeight;
}

function renderSessions(state) {
  sessions.replaceChildren();
  const items =
    state.sessions.length > 0
      ? state.sessions
      : [{ id: activeId || "this", title: "This chat" }];
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.title || "Chat";
    if (item.id === state.activeId) {
      button.setAttribute("aria-current", "true");
    }
    button.addEventListener("click", () => {
      activeId = item.id;
      window.pa
        .invoke("chat_open", { sessionId: item.id })
        .then(refresh)
        .catch((error) => {
          modelError.textContent = window.pa.explain(error, "Chat");
        });
    });
    sessions.append(button);
  }
}

function displayOrder(messages) {
  const ordered = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message.role !== "user") {
      ordered.push(message);
      index += 1;
      continue;
    }
    const rest = [];
    index += 1;
    while (index < messages.length && messages[index].role !== "user") {
      rest.push(messages[index]);
      index += 1;
    }
    ordered.push(
      message,
      ...rest.filter((item) => item.role === "approval"),
      ...rest.filter((item) => item.role !== "approval"),
    );
  }
  return ordered;
}

function settledLine(text) {
  const raw = String(text ?? "");
  const denied = raw.includes("(denied)");
  const cancelled = raw.includes("(cancelled)");
  const body = raw
    .replace(/\s*\((?:approved|denied|cancelled|read)\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const click = /click "([^"]+)"/i.exec(body);
  if (click) {
    if (denied) {
      return `Denied: ${click[1]}`;
    }
    if (cancelled) {
      return "Cancelled";
    }
    return `Clicked "${click[1]}"`;
  }
  const typed = /type "[^"]*" into "([^"]+)"/i.exec(body);
  if (typed || /\btype\b/i.test(body)) {
    const field = typed?.[1] ?? "";
    if (denied) {
      return field.length > 0 ? `Denied: ${field}` : "Denied";
    }
    if (cancelled) {
      return "Cancelled";
    }
    return field.length > 0 ? `Typed into "${field}"` : "Typed into a field";
  }
  const visit = /\bvisit\s+(\S+)/i.exec(body);
  if (visit?.[1]) {
    const host = visit[1].replace(/[.,]+$/, "");
    if (denied) {
      return `Denied: ${host}`;
    }
    if (cancelled) {
      return "Cancelled";
    }
    if (raw.includes("(read)")) {
      return `Read ${host}`;
    }
    return `Reading ${host}…`;
  }
  const open = /(?:navigate to|open)\s+(\S+)/i.exec(body);
  if (open?.[1]) {
    const host = open[1].replace(/[.,]+$/, "");
    if (denied) {
      return `Denied: ${host}`;
    }
    if (cancelled) {
      return "Cancelled";
    }
    if (/could not confirm|did not open|was not opened/i.test(raw)) {
      return `Did not open ${host}`;
    }
    return `Opened ${host}`;
  }
  if (denied) {
    return "Denied";
  }
  if (cancelled) {
    return "Cancelled";
  }
  return body.length > 0 ? body : "Approved";
}

function settled(text) {
  const value = String(text ?? "");
  return (
    value.includes("(approved)") ||
    value.includes("(denied)") ||
    value.includes("(cancelled)") ||
    value.includes("(read)")
  );
}

function progressLine(summary) {
  const text = String(summary ?? "");
  const click = /click "([^"]+)"/i.exec(text);
  if (click) {
    return `Clicking "${click[1]}"…`;
  }
  if (/\btype\b/i.test(text)) {
    return "Typing…";
  }
  const visit = /\bvisit\s+(\S+)/i.exec(text);
  if (visit?.[1]) {
    return `Reading ${visit[1].replace(/[.,]+$/, "")}…`;
  }
  const open = /(?:navigate to|open)\s+(\S+)/i.exec(text);
  if (open?.[1]) {
    return `Opening ${open[1].replace(/[.,]+$/, "")}…`;
  }
  return "Working…";
}

function lockCard(card, statusText) {
  if (!(card instanceof HTMLElement) || card.dataset.locked === "1") {
    return false;
  }
  card.dataset.locked = "1";
  const id = card.dataset.approvalId;
  if (id) {
    lockedCards.set(id, statusText);
    storeLocks();
  }
  paint += 1;
  for (const node of card.querySelectorAll("button")) {
    node.disabled = true;
    node.remove();
  }
  const status = document.createElement("p");
  status.className = "muted";
  status.dataset.status = "1";
  status.textContent = statusText;
  card.append(status);
  return true;
}

function decisionButton(label, id, action, summary) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  const start = (card) => {
    window.pa
      .invoke("chat_approve", { id, action })
      .then(refresh)
      .catch(() => {
        const status = card.querySelector("[data-status]");
        const held = lockedCards.get(id);
        if (status && held) {
          status.textContent = held;
        }
      });
  };
  const run = (event) => {
    const card = button.closest("article");
    const statusText = action === "deny" ? "Denied" : progressLine(summary);
    if (!card) {
      return;
    }
    if (card.dataset.locked === "1") {
      if (event.type === "click") {
        for (const node of card.querySelectorAll("button")) {
          node.remove();
        }
      }
      return;
    }
    if (event.type === "mousedown") {
      card.dataset.locked = "1";
      lockedCards.set(id, statusText);
      storeLocks();
      paint += 1;
      const status = document.createElement("p");
      status.className = "muted";
      status.dataset.status = "1";
      status.textContent = statusText;
      card.append(status);
      start(card);
      return;
    }
    if (!lockCard(card, statusText)) {
      return;
    }
    start(card);
  };
  button.addEventListener("mousedown", run);
  button.addEventListener("click", run);
  return button;
}

function setSending(active) {
  sendButton.textContent = active ? "Stop" : "Send";
}

async function refresh() {
  const seen = round;
  const mine = ++paint;
  const state = normalize(
    JSON.parse(
      await window.pa.invoke("chat_state", {
        sessionId: activeId,
      }),
    ),
  );
  if (seen !== round || mine !== paint) {
    return state;
  }
  activeId = state.activeId || activeId;
  pendingApprovals = state.pending ?? [];
  if (state.streaming || pendingApprovals.length > 0) {
    sending = true;
  }
  renderSessions(state);
  renderMessages(state.messages);
  if (sending) {
    setSending(true);
  } else {
    setSending(false);
  }
  window.clearTimeout(hostWatch);
  if (state.streaming || pendingApprovals.length > 0) {
    hostWatch = window.setTimeout(() => {
      refresh().catch(() => {});
    }, 200);
  }
  if (state.notice) {
    modelNotice.textContent = state.notice;
  }
  if (state.models) {
    for (const role of Object.keys(selects)) {
      const selected = state.models[role];
      if (selected && selects[role].value !== selected) {
        const has = [...selects[role].options].some(
          (option) => option.value === selected,
        );
        if (!has) {
          fillSelect(selects[role], [{ name: selected }], selected);
        } else {
          selects[role].value = selected;
        }
      }
    }
  }
  return state;
}

async function loadModels() {
  const parsed = JSON.parse(await window.pa.invoke("list_models"));
  const models = Array.isArray(parsed) ? parsed : (parsed.models ?? []);
  const selected = parsed.selected ?? defaults;
  for (const role of Object.keys(selects)) {
    fillSelect(selects[role], models, selected[role] || defaults[role]);
  }
  const running =
    parsed.running !== false &&
    !String(parsed.notice || "").includes("not running");
  ollamaDot.className = running ? "dot good" : "dot warn";
  modelNotice.textContent =
    parsed.notice ||
    (running
      ? "Ollama is running"
      : window.pa.explain("Ollama is not running", "Models"));
}

function showModelNote(text, ok) {
  window.clearTimeout(savedTimer);
  modelError.className = ok ? "notice ok" : "notice";
  modelError.textContent = text;
  if (!ok) {
    return;
  }
  savedTimer = window.setTimeout(() => {
    if (modelError.textContent === text) {
      modelError.textContent = "";
      modelError.className = "notice";
    }
  }, 2000);
}

document.getElementById("models").addEventListener("submit", (event) => {
  event.preventDefault();
  window.clearTimeout(savedTimer);
  modelError.className = "notice";
  modelError.textContent = "";
  window.pa
    .invoke("set_models", {
      chat: selects.chat.value,
      agent: selects.agent.value,
      builder: selects.builder.value,
    })
    .then(() => {
      showModelNote("Saved", true);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      showModelNote(
        /unavailable/i.test(message)
          ? window.pa.explain(error, "Models")
          : message,
        false,
      );
    });
});

document.getElementById("new-chat").addEventListener("click", () => {
  window.pa
    .invoke("chat_new")
    .then((raw) => {
      const state = normalize(JSON.parse(raw));
      activeId = state.activeId;
      return refresh();
    })
    .catch((error) => {
      modelError.textContent = window.pa.explain(error, "Chat");
    });
});

async function submitChat(text) {
  if (sending) {
    round += 1;
    optimisticText = "";
    await window.pa.invoke("chat_stop", { sessionId: activeId });
    sending = false;
    setSending(false);
    await refresh();
    return;
  }
  const mine = ++round;
  sending = true;
  optimisticText = text;
  setSending(true);
  showPendingThought();
  const poll = setInterval(() => {
    if (mine !== round) {
      return;
    }
    refresh().catch(() => {});
  }, 120);
  try {
    await window.pa.invoke("chat_send", { text, sessionId: activeId });
  } catch (error) {
    if (mine === round && lockedCards.size === 0) {
      modelError.textContent = window.pa.explain(error, "Chat");
    } else if (mine === round) {
      modelError.textContent = "Chrome is still opening that page.";
    }
  } finally {
    clearInterval(poll);
    if (mine === round) {
      await settleTurn(mine);
    }
  }
}

async function settleTurn(mine) {
  const state = await refresh().catch(() => null);
  if (mine !== round || !state) {
    return;
  }
  if (state.streaming || state.pending.length > 0) {
    sending = true;
    setSending(true);
    window.setTimeout(() => {
      if (mine === round) {
        settleTurn(mine).catch(() => {});
      }
    }, 200);
    return;
  }
  sending = false;
  optimisticText = "";
  setSending(false);
  await refresh();
}

document.getElementById("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = draft.value.trim();
  if (!sending && text.length === 0) {
    return;
  }
  if (!sending) {
    draft.value = "";
  }
  submitChat(text).catch((error) => {
    if (lockedCards.size > 0) {
      if (!modelError.textContent) {
        modelError.textContent = "Chrome is still opening that page.";
      }
      return;
    }
    modelError.textContent = window.pa.explain(error, "Chat");
  });
});

draft.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    document.getElementById("composer").requestSubmit();
  }
});

for (const role of Object.keys(selects)) {
  fillSelect(selects[role], [defaults[role]], defaults[role]);
}

loadModels().catch((error) => {
  modelNotice.textContent = window.pa.explain(error, "Models");
  ollamaDot.className = "dot warn";
});
refresh().catch((error) => {
  thread.replaceChildren();
  const note = document.createElement("p");
  note.className = "notice";
  note.textContent = window.pa.explain(error, "Chat");
  thread.append(note);
});
