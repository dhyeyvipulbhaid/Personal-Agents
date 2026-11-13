const root = document.getElementById("requests");
const hint = document.getElementById("approval-help");
let items = [];
let selected = 0;
const lockedCards = new Map();

function snoozeUntil(choice) {
  const hour = 60 * 60 * 1000;
  if (choice === "4h") {
    return Date.now() + 4 * hour;
  }
  if (choice === "tomorrow") {
    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(9, 0, 0, 0);
    return next.getTime();
  }
  return Date.now() + hour;
}

function pillLabels(item) {
  const effects = Array.isArray(item.effects) ? item.effects : [];
  const capability = item.capability || "";
  if (capability === "mail.send" || effects.includes("sends")) {
    return ["Writes to local outbox"];
  }
  return [...effects, capability].filter((label) => label.length > 0);
}

function riskClass(label) {
  if (/delete/i.test(label)) {
    return "danger";
  }
  if (/send/i.test(label)) {
    return "warn";
  }
  return "ask";
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
  const open = /(?:visit|navigate to|open)\s+(\S+)/i.exec(text);
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
  const id = card.dataset.id;
  if (id) {
    lockedCards.set(id, statusText);
  }
  const row = card.querySelector(".button-row");
  for (const node of card.querySelectorAll("button")) {
    node.disabled = true;
    node.remove();
  }
  const status = document.createElement("p");
  status.className = "muted";
  status.dataset.status = "1";
  status.textContent = statusText;
  (row ?? card).append(status);
  return true;
}

async function act(action, id, extra, refresh = true) {
  await window.pa.invoke("approval_act", {
    action,
    id,
    draft: extra.draft || "",
    instruction: extra.instruction || "",
    scope: extra.scope || "once",
    until: extra.until || 0,
  });
  if (refresh) {
    await showRequests();
  }
}

function button(label, className, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", () => {
    onClick().catch(() => {
      const note = document.createElement("p");
      note.className = "notice";
      note.textContent = "That request did not finish. The card stays locked.";
      root.prepend(note);
    });
  });
  return node;
}

function render(next) {
  items = next;
  const alive = new Set(items.map((item) => item.id));
  for (const id of lockedCards.keys()) {
    if (!alive.has(id)) {
      lockedCards.delete(id);
    }
  }
  root.replaceChildren();
  if (items.length === 0) {
    root.textContent = "No waiting requests";
    return;
  }
  if (selected >= items.length) {
    selected = 0;
  }
  items.forEach((item, index) => {
    const block = document.createElement("article");
    block.className = "card";
    block.dataset.id = item.id;
    if (index === selected) {
      block.classList.add("is-selected");
    }
    const title = document.createElement("h2");
    title.textContent = item.summary;
    const source = document.createElement("p");
    source.className = "muted";
    source.textContent = `Source ${item.taskId || "app"}`;
    const pills = document.createElement("p");
    for (const label of pillLabels(item)) {
      const pill = document.createElement("span");
      pill.className = `pill ${riskClass(label)}`;
      pill.textContent = label;
      pills.append(pill);
    }
    const evidence = document.createElement("textarea");
    evidence.className = "evidence";
    evidence.rows = 8;
    evidence.value = item.draft ?? "";
    evidence.setAttribute("aria-label", "Evidence");
    const once = document.createElement("option");
    once.value = "once";
    once.textContent = "Once";
    const task = document.createElement("option");
    task.value = "task";
    task.textContent = "For this task";
    const scope = document.createElement("select");
    scope.append(once, task);
    scope.setAttribute("aria-label", "Scope");
    const duration = document.createElement("select");
    duration.setAttribute("aria-label", "Snooze");
    for (const [value, label] of [
      ["1h", "1 hour"],
      ["4h", "4 hours"],
      ["tomorrow", "Tomorrow"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      duration.append(option);
    }
    const info = document.createElement("input");
    info.placeholder = "More info";
    const buttons = document.createElement("div");
    buttons.className = "button-row";
    buttons.append(
      button("Approve", "", async () => {
        if (!lockCard(block, progressLine(item.summary))) {
          return;
        }
        if (evidence.value !== item.draft) {
          await act("edit", item.id, { draft: evidence.value }, false);
        }
        await act("approve", item.id, { scope: scope.value });
      }),
      button("Edit", "ghost", () =>
        act("edit", item.id, { draft: evidence.value }),
      ),
      button("Deny", "danger", async () => {
        if (!lockCard(block, "Denied")) {
          return;
        }
        await act("deny", item.id, {});
      }),
      button("Snooze", "ghost", () =>
        act("snooze", item.id, { until: snoozeUntil(duration.value) }),
      ),
      button("Provide more info", "quiet", () =>
        act("more-info", item.id, { instruction: info.value }),
      ),
    );
    block.append(
      title,
      source,
      pills,
      evidence,
      scope,
      duration,
      info,
      buttons,
    );
    if (lockedCards.has(item.id)) {
      lockCard(block, lockedCards.get(item.id));
    }
    root.append(block);
  });
}

function current() {
  return items[selected];
}

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target.closest("input, textarea, select, button")
  ) {
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "j" || key === "k") {
    event.preventDefault();
    if (items.length === 0) {
      return;
    }
    selected =
      key === "j"
        ? Math.min(items.length - 1, selected + 1)
        : Math.max(0, selected - 1);
    render(items);
    return;
  }
  const item = current();
  if (!item) {
    return;
  }
  const card = root.querySelector(".is-selected");
  if (key === "a") {
    event.preventDefault();
    card?.querySelector("button")?.click();
  } else if (key === "e") {
    event.preventDefault();
    card?.querySelector("textarea")?.focus();
  } else if (key === "r") {
    event.preventDefault();
    [...(card?.querySelectorAll("button") ?? [])]
      .find((node) => node.textContent === "Deny")
      ?.click();
  } else if (key === "s") {
    event.preventDefault();
    [...(card?.querySelectorAll("button") ?? [])]
      .find((node) => node.textContent === "Snooze")
      ?.click();
  }
});

async function showRequests() {
  const parsed = JSON.parse(await window.pa.invoke("approvals"));
  if (!Array.isArray(parsed)) {
    throw new Error("approvals payload is invalid");
  }
  render(parsed);
}

if (hint) {
  hint.textContent = "j and k move · a approve · e edit · r deny · s snooze";
}

showRequests().catch((error) => {
  root.textContent = window.pa.explain(error, "Approvals");
});
