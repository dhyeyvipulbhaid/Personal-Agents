const list = document.getElementById("activity");

function asEntry(entry) {
  if (typeof entry === "string") {
    try {
      return asEntry(JSON.parse(entry));
    } catch {
      return { at: "", summary: entry };
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

async function showActivity() {
  const raw = await window.__TAURI__.core.invoke("audit_log");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("audit log is invalid");
  }
  list.replaceChildren();
  for (const entry of newestFirst(parsed)) {
    const item = document.createElement("li");
    item.textContent = typeof entry.summary === "string" ? entry.summary : "";
    list.append(item);
  }
}

showActivity().catch(() => {
  list.textContent = "Activity unavailable";
});
