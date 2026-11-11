const defaults = {
  chat: "qwen3:4b",
  agent: "qwen3:8b",
  builder: "qwen2.5-coder:7b",
};

const thread = document.getElementById("thread");
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

function normalize(parsed) {
  if (Array.isArray(parsed)) {
    return {
      messages: parsed,
      sessions: [{ id: "this", title: "This chat" }],
      activeId: "this",
      streaming: false,
      models: null,
      notice: "",
    };
  }
  return {
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    activeId: typeof parsed.activeId === "string" ? parsed.activeId : "",
    streaming: Boolean(parsed.streaming),
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
  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent =
      "Send a message to the local model. Enter sends. Shift+Enter adds a line.";
    thread.append(empty);
    return;
  }
  for (const message of messages) {
    if (message.role === "approval") {
      const card = document.createElement("article");
      card.className = "card inline-approval";
      const text = document.createElement("p");
      text.textContent = message.text;
      card.append(text);
      if (message.approvalId && !settled(message.text)) {
        card.append(
          decisionButton("Approve", message.approvalId, "approve", text),
          decisionButton("Deny", message.approvalId, "deny", text),
        );
      }
      thread.append(card);
      continue;
    }
    if (message.role === "memory") {
      const note = document.createElement("p");
      note.className = "memory-note";
      note.textContent = message.text;
      thread.append(note);
      continue;
    }
    const role = message.role === "user" ? "user" : "assistant";
    if (
      role === "assistant" &&
      String(message.text ?? "").trim().length === 0
    ) {
      continue;
    }
    const bubble = document.createElement("div");
    bubble.className = `bubble ${role}`;
    if (role === "assistant") {
      bubble.innerHTML = markdownToHtml(message.text ?? "");
    } else {
      bubble.textContent = message.text ?? "";
    }
    thread.append(bubble);
  }
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

function settled(text) {
  const value = String(text ?? "");
  return (
    value.includes("(approved)") ||
    value.includes("(denied)") ||
    value.includes("(cancelled)")
  );
}

function decisionButton(label, id, action, text) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => {
    window.pa
      .invoke("chat_approve", { id, action })
      .then(refresh)
      .catch((error) => {
        text.textContent = window.pa.explain(error, "Approval");
      });
  });
  return button;
}

function setSending(active) {
  sendButton.textContent = active ? "Stop" : "Send";
}

async function refresh() {
  const state = normalize(
    JSON.parse(
      await window.pa.invoke("chat_state", {
        sessionId: activeId,
      }),
    ),
  );
  activeId = state.activeId || activeId;
  renderSessions(state);
  renderMessages(state.messages);
  if (sending && state.streaming) {
    setSending(true);
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

document.getElementById("models").addEventListener("submit", (event) => {
  event.preventDefault();
  modelError.textContent = "";
  window.pa
    .invoke("set_models", {
      chat: selects.chat.value,
      agent: selects.agent.value,
      builder: selects.builder.value,
    })
    .then(() => {
      modelError.textContent = "Saved";
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      modelError.textContent = /unavailable/i.test(message)
        ? window.pa.explain(error, "Models")
        : message;
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
    await window.pa.invoke("chat_stop", { sessionId: activeId });
    sending = false;
    setSending(false);
    await refresh();
    return;
  }
  const mine = ++round;
  sending = true;
  setSending(true);
  const poll = setInterval(() => {
    if (mine !== round) {
      return;
    }
    refresh().catch(() => {});
  }, 120);
  try {
    await window.pa.invoke("chat_send", { text, sessionId: activeId });
  } catch (error) {
    if (mine === round) {
      modelError.textContent = window.pa.explain(error, "Chat");
    }
  } finally {
    clearInterval(poll);
    if (mine === round) {
      sending = false;
      setSending(false);
    }
    await refresh();
  }
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
