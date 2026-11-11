const list = document.getElementById("checks");

async function showChecks() {
  const raw = await window.__TAURI__.core.invoke("capabilities");
  const checks = JSON.parse(raw);
  list.replaceChildren();
  for (const check of checks) {
    const item = document.createElement("li");
    const cause = check.cause ? ` (${check.cause})` : "";
    item.textContent = `${check.status}: ${check.name}${cause}`;
    list.append(item);
  }
}

showChecks().catch(() => {
  list.textContent = "Capabilities unavailable";
});
