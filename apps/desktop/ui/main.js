const versionNode = document.getElementById("host-version");
const themeSelect = document.getElementById("theme");
const widgetsRoot = document.getElementById("widgets");
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
const themeKey = "pa-theme";

let widgetPayload = [];

function themeChoice() {
  const stored = localStorage.getItem(themeKey);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

function resolvedTheme() {
  const choice = themeChoice();
  if (choice === "light" || choice === "dark") {
    return choice;
  }
  return themeMedia.matches ? "dark" : "light";
}

function applyShellTheme() {
  const choice = themeChoice();
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeChoice = choice;
  if (themeSelect.value !== choice) {
    themeSelect.value = choice;
  }
  return theme;
}

function themedHtml(html, theme) {
  const safe = theme === "dark" ? "dark" : "light";
  return String(html).split("__PA_THEME__").join(safe);
}

function renderWidgets() {
  const theme = applyShellTheme();
  widgetsRoot.replaceChildren();
  for (const widget of widgetPayload) {
    const frame = document.createElement("iframe");
    frame.className = "widget-frame";
    frame.setAttribute("sandbox", "");
    frame.title = widget.title;
    frame.srcdoc = themedHtml(widget.html, theme);
    widgetsRoot.append(frame);
  }
}

themeSelect.addEventListener("change", () => {
  const value = themeSelect.value;
  if (value !== "light" && value !== "dark" && value !== "system") {
    return;
  }
  localStorage.setItem(themeKey, value);
  renderWidgets();
});

themeMedia.addEventListener("change", () => {
  if (themeChoice() === "system") {
    renderWidgets();
  }
});

async function showHostVersion() {
  const version = await window.__TAURI__.core.invoke("host_version");
  versionNode.textContent = `Agent host ${version}`;
  await window.__TAURI__.core.invoke("note_displayed_host_version", {
    version,
  });
}

async function showWidgets() {
  const raw = await window.__TAURI__.core.invoke("widgets");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("widgets payload is invalid");
  }
  widgetPayload = parsed.filter(
    (item) =>
      item && typeof item.html === "string" && typeof item.title === "string",
  );
  renderWidgets();
}

applyShellTheme();
showHostVersion().catch(() => {
  versionNode.textContent = "Agent host unavailable";
});
showWidgets().catch(() => {
  widgetsRoot.textContent = "Widgets unavailable";
});
