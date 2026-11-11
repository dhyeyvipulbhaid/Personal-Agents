const root = document.getElementById("requests");

async function act(action, id, extra) {
  await window.__TAURI__.core.invoke("approval_act", {
    action,
    id,
    draft: extra.draft || "",
    instruction: extra.instruction || "",
    scope: extra.scope || "once",
    until: extra.until || 0,
  });
  await showRequests();
}

function render(items) {
  root.replaceChildren();
  if (items.length === 0) {
    root.textContent = "No waiting requests";
    return;
  }
  for (const item of items) {
    const block = document.createElement("article");
    block.dataset.id = item.id;
    const title = document.createElement("h2");
    title.textContent = item.summary;
    const draft = document.createElement("textarea");
    draft.value = item.draft;
    const once = document.createElement("option");
    once.value = "once";
    once.textContent = "Once";
    const task = document.createElement("option");
    task.value = "task";
    task.textContent = "For this task";
    const scope = document.createElement("select");
    scope.append(once, task);
    const info = document.createElement("input");
    info.placeholder = "More info";
    const buttons = document.createElement("p");
    buttons.append(
      button("Approve", async () => {
        await act("edit", item.id, { draft: draft.value });
        await act("approve", item.id, { scope: scope.value });
      }),
      button("Deny", () => act("deny", item.id, {})),
      button("Provide more info", () =>
        act("more-info", item.id, { instruction: info.value }),
      ),
      button("Edit", () => act("edit", item.id, { draft: draft.value })),
      button("Snooze", () =>
        act("snooze", item.id, { until: Date.now() + 60 * 60 * 1000 }),
      ),
    );
    block.append(title, draft, scope, info, buttons);
    root.append(block);
  }
}

function button(label, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.addEventListener("click", () => {
    onClick().catch(() => {
      root.textContent = "Approvals unavailable";
    });
  });
  return node;
}

async function showRequests() {
  const raw = await window.__TAURI__.core.invoke("approvals");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("approvals payload is invalid");
  }
  render(parsed);
}

showRequests().catch(() => {
  root.textContent = "Approvals unavailable";
});
