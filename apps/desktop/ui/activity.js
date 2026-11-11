const list = document.getElementById("activity");

function asEntry(entry) {
  if (typeof entry === "string") {
    try {
      return asEntry(JSON.parse(entry));
    } catch {
      return { at: "", summary: entry, decision: "event", pluginId: "" };
    }
  }
  return entry && typeof entry === "object" ? entry : { at: "", summary: "" };
}

function newestFirst(entries) {
  return entries.map(asEntry).sort((left, right) => {
    const a = typeof left.at === "string" ? left.at : "";
    const b = typeof right.at === "string" ? right.at : "";
    if (a === b) {
      return 0;
    }
    return a < b ? 1 : -1;
  });
}

function readable(value) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatTime(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function showActivity() {
  const parsed = JSON.parse(await window.pa.invoke("audit_log"));
  if (!Array.isArray(parsed)) {
    throw new Error("audit log is invalid");
  }
  list.replaceChildren();
  const entries = newestFirst(parsed);
  if (entries.length === 0) {
    const item = document.createElement("li");
    item.textContent =
      "No activity yet. Approvals, denials, and blocked actions will be listed here, newest first.";
    list.append(item);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.dateTime = typeof entry.at === "string" ? entry.at : "";
    time.textContent = formatTime(entry.at);
    const kind = document.createElement("span");
    kind.className = "pill";
    kind.textContent =
      typeof entry.decision === "string" && entry.decision.length > 0
        ? entry.decision
        : "event";
    const message = document.createElement("span");
    message.className = "message";
    message.textContent = readable(
      typeof entry.summary === "string" ? entry.summary : "",
    );
    const plugin = document.createElement("span");
    plugin.className = "plugin";
    plugin.textContent =
      typeof entry.pluginId === "string" && entry.pluginId.length > 0
        ? entry.pluginId
        : "";
    item.append(time, kind, message, plugin);
    list.append(item);
  }
}

showActivity().catch((error) => {
  list.textContent = window.pa.explain(error, "Activity");
});
