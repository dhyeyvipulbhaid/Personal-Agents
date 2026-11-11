const themeKey = "pa-theme";
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
const themeListeners = [];

const pages = [
  ["index.html", "Home", "home"],
  ["chat.html", "Chat", "chat"],
  ["approvals.html", "Approvals", "approvals"],
  ["activity.html", "Activity", "activity"],
  ["capabilities.html", "Capabilities", "capabilities"],
  ["builder.html", "Builder", "builder"],
  ["memory.html", "Memory", "memory"],
  ["mail.html", "Mail", "mail"],
];

const icons = {
  home: '<path d="M3 7.5 8 3l5 4.5V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  chat: '<path d="M3 4.5h10v6H6l-3 2.5z"/>',
  approvals:
    '<path d="M3.5 8.5 6.5 11 12.5 4"/><rect x="2.5" y="2.5" width="11" height="11" rx="2"/>',
  activity: '<path d="M3 4.5h10M3 8h10M3 11.5h6"/>',
  capabilities:
    '<path d="M8 2.5 13 4.5v4c0 3-2.2 4.7-5 5.5-2.8-.8-5-2.5-5-5.5v-4z"/>',
  builder: '<path d="M3 6.5 8 3.5l5 3v6L8 15.5l-5-3z"/>',
  memory: '<path d="M4 3.5h8v10l-4-2-4 2z"/>',
  mail: '<path d="M2.5 4.5h11v8h-11z"/><path d="m3 5 5 4 5-4"/>',
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

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

function applyTheme() {
  const choice = themeChoice();
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeChoice = choice;
  const select = document.getElementById("theme");
  if (select && select.value !== choice) {
    select.value = choice;
  }
  for (const listener of themeListeners) {
    listener(theme);
  }
  return theme;
}

function explain(error, what) {
  let detail = "the agent host did not answer";
  if (typeof error === "string" && error.trim()) {
    detail = error.trim();
  } else if (error instanceof Error && error.message) {
    detail = error.message;
  } else if (error && typeof error === "object" && "message" in error) {
    detail = String(error.message);
  } else if (error != null) {
    detail = String(error);
  }
  if (/unavailable/i.test(detail)) {
    detail = "the agent host did not answer";
  }
  return `${what} did not load. ${detail}. Quit Personal Agents and open it again. The host log is host.log in this app's data folder.`;
}

async function invoke(command, args) {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke) {
    throw new Error("This page is not running inside Personal Agents.");
  }
  return tauri.core.invoke(command, args);
}

window.pa = {
  onTheme(listener) {
    themeListeners.push(listener);
  },
  theme() {
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  },
  explain,
  invoke,
};

function mountShell() {
  const root = document.getElementById("shell-root");
  const template = document.getElementById("page-body");
  if (!root || !template) {
    return;
  }
  const links = pages
    .map(([href, label, name]) => {
      const badge =
        name === "approvals"
          ? '<span class="badge" id="approval-badge" hidden></span>'
          : "";
      return `<a href="${href}">${icon(name)}<span>${label}</span>${badge}</a>`;
    })
    .join("");
  root.innerHTML = `
    <header class="topbar">
      <a class="brand" href="index.html">Personal Agents</a>
      <label class="theme-menu">Theme
        <select id="theme" aria-label="Theme">
          <option value="system">Follow system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
    </header>
    <div class="layout">
      <aside class="sidebar">
        <nav aria-label="Pages">${links}</nav>
        <div class="sidebar-footer">
          <p id="ollama-status">Checking Ollama …</p>
          <p>Running locally. All data stays on this machine.</p>
        </div>
      </aside>
      <main id="main-slot"></main>
    </div>`;
  document
    .getElementById("main-slot")
    ?.append(template.content.cloneNode(true));
  const file = decodeURIComponent(location.pathname).split("/").pop();
  for (const link of root.querySelectorAll("nav a")) {
    if (link.getAttribute("href") === file) {
      link.setAttribute("aria-current", "page");
    }
  }
  document.getElementById("theme")?.addEventListener("change", () => {
    const value = document.getElementById("theme").value;
    if (value !== "light" && value !== "dark" && value !== "system") {
      return;
    }
    localStorage.setItem(themeKey, value);
    applyTheme();
  });
}

async function showOllama() {
  const node = document.getElementById("ollama-status");
  if (!node) {
    return;
  }
  try {
    const status = await invoke("ollama_status");
    if (status === "running") {
      node.textContent = "Ollama is running";
      return;
    }
    node.textContent = "";
    node.append("Ollama is not running. ");
    const link = document.createElement("a");
    link.href = "https://ollama.com/download";
    link.textContent = "Install Ollama";
    node.append(link);
  } catch (error) {
    node.textContent = explain(error, "Ollama");
  }
}

async function showBadge() {
  const badge = document.getElementById("approval-badge");
  if (!badge) {
    return;
  }
  try {
    const parsed = JSON.parse(await invoke("approvals"));
    const count = Array.isArray(parsed) ? parsed.length : 0;
    badge.hidden = count === 0;
    badge.textContent = count > 0 ? String(count) : "";
  } catch {
    badge.hidden = true;
    badge.textContent = "";
  }
}

mountShell();
applyTheme();
themeMedia.addEventListener("change", () => {
  if (themeChoice() === "system") {
    applyTheme();
  }
});
showOllama();
showBadge();
