const transcript = document.getElementById("transcript");
const modelError = document.getElementById("model-error");

function render(messages) {
  transcript.replaceChildren();
  for (const message of messages) {
    const item = document.createElement("li");
    item.textContent = `${message.role}: ${message.text}`;
    if (message.role === "approval" && message.approvalId) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Approve";
      button.addEventListener("click", () => {
        window.__TAURI__.core
          .invoke("chat_approve", { id: message.approvalId })
          .then(show)
          .catch(() => {
            item.textContent = "Approval failed";
          });
      });
      item.append(button);
    }
    transcript.append(item);
  }
}

async function show() {
  const raw = await window.__TAURI__.core.invoke("chat_state");
  render(JSON.parse(raw));
}

document.getElementById("models").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  modelError.textContent = "";
  window.__TAURI__.core
    .invoke("set_models", {
      chat: String(data.get("chat") ?? ""),
      agent: String(data.get("agent") ?? ""),
      builder: String(data.get("builder") ?? ""),
    })
    .then(() => {
      modelError.textContent = "Saved";
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      modelError.textContent = message;
    });
});

document.getElementById("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const text = String(data.get("text") ?? "");
  window.__TAURI__.core
    .invoke("chat_send", { text })
    .then(show)
    .catch(() => {
      transcript.textContent = "Chat unavailable";
    });
});

show().catch(() => {
  transcript.textContent = "Chat unavailable";
});
