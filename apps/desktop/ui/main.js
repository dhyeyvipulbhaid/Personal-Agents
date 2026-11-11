const versionNode = document.getElementById("host-version");
const widgetsRoot = document.getElementById("widgets");
const layoutGrid = document.getElementById("layout-grid");
const layoutList = document.getElementById("layout-list");
const densityComfortable = document.getElementById("density-comfortable");
const densityCompact = document.getElementById("density-compact");

let widgetPayload = [];
let widgetError = "";
let revenueState = { error: "" };
let mailState = { error: "" };
let approvalState = { error: "", count: 0 };

function themedHtml(html, theme) {
  const safe = theme === "dark" ? "dark" : "light";
  return String(html).split("__PA_THEME__").join(safe);
}

function shortTime(value) {
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

function card(title, health, updated) {
  const article = document.createElement("article");
  article.className = "card";
  const head = document.createElement("header");
  head.className = "card-head";
  const dot = document.createElement("span");
  dot.className = `dot ${health}`;
  const heading = document.createElement("h2");
  heading.textContent = title;
  const time = document.createElement("time");
  time.textContent = updated;
  head.append(dot, heading, time);
  article.append(head);
  return article;
}

function actions(...nodes) {
  const row = document.createElement("div");
  row.className = "actions";
  row.append(...nodes);
  return row;
}

function button(label, className, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

function link(href, label) {
  const node = document.createElement("a");
  node.href = href;
  node.textContent = label;
  return node;
}

function widgetCard(widget) {
  const article = card(widget.title || "Widget", "good", "Updated just now");
  const frame = document.createElement("iframe");
  frame.className = "widget-frame";
  frame.setAttribute("sandbox", "");
  frame.title = widget.title || "Widget";
  frame.srcdoc = themedHtml(widget.html, window.pa.theme());
  article.append(frame);
  return article;
}

function revenueCard() {
  if (revenueState.error) {
    const article = card("Revenue", "bad", "");
    const note = document.createElement("p");
    note.className = "notice";
    note.id = "revenue-status";
    note.textContent = revenueState.error;
    article.append(note);
    article.append(actions(button("Refresh", "ghost", () => showRevenue())));
    return article;
  }
  const data = revenueState.data;
  if (!data) {
    const article = card("Revenue", "warn", "Checking the sample file");
    const note = document.createElement("p");
    note.id = "revenue-status";
    note.textContent = "Reading the demo revenue file that ships with the app.";
    article.append(note);
    return article;
  }
  const article = card(
    "Revenue",
    data.health === "alert" ? "warn" : "good",
    data.lastRefresh ? `Updated ${shortTime(data.lastRefresh)}` : "",
  );
  const total = document.createElement("p");
  total.className = "total";
  total.textContent = String(data.total);
  const line = document.createElement("p");
  line.id = "revenue-status";
  line.textContent = data.line || "";
  article.append(total, line);
  if (Array.isArray(data.alerts) && data.alerts.length > 0) {
    const alerts = document.createElement("p");
    alerts.textContent = `Alert: ${data.alerts.join(", ")} dropped by 10% or more.`;
    article.append(alerts);
  }
  const rows = document.createElement("p");
  rows.className = "muted";
  rows.textContent = Array.isArray(data.rows)
    ? data.rows.map((row) => `${row.vertical} ${row.amount}`).join(" · ")
    : "";
  article.append(rows);
  article.append(actions(button("Refresh", "ghost", () => showRevenue())));
  return article;
}

function digestCard() {
  return listCard(
    "Mail digest",
    mailState.error,
    mailState.data?.digest,
    "Open mail",
    "mail.html",
    "Threads from the last day of the sample mailbox.",
  );
}

function followCard() {
  return listCard(
    "Follow-ups",
    mailState.error,
    mailState.data?.followUps,
    "Open mail",
    "mail.html",
    "Threads that are waiting on a reply.",
  );
}

function listCard(title, error, items, action, href, empty) {
  const article = card(title, error ? "bad" : "good", "Sample mailbox");
  if (error) {
    const note = document.createElement("p");
    note.className = "notice";
    note.textContent = error;
    article.append(note);
    return article;
  }
  const list = document.createElement("ul");
  list.className = "plain-list";
  const values = Array.isArray(items) ? items : [];
  if (values.length === 0) {
    const item = document.createElement("li");
    item.textContent = empty;
    list.append(item);
  }
  for (const value of values) {
    const item = document.createElement("li");
    item.textContent = value;
    list.append(item);
  }
  article.append(list, actions(link(href, action)));
  return article;
}

function approvalCard() {
  const article = card(
    "Approvals",
    approvalState.error ? "bad" : approvalState.count > 0 ? "warn" : "good",
    "",
  );
  const note = document.createElement("p");
  if (approvalState.error) {
    note.className = "notice";
    note.textContent = approvalState.error;
  } else if (approvalState.count === 0) {
    note.textContent = "No requests waiting.";
  } else {
    note.textContent = `${approvalState.count} request${approvalState.count === 1 ? "" : "s"} waiting.`;
  }
  article.append(note, actions(link("approvals.html", "Review")));
  return article;
}

function renderDashboard() {
  if (!widgetsRoot) {
    return;
  }
  widgetsRoot.replaceChildren();
  if (widgetError) {
    const note = document.createElement("p");
    note.className = "notice";
    note.textContent = widgetError;
    widgetsRoot.append(note);
  }
  for (const widget of widgetPayload) {
    widgetsRoot.append(widgetCard(widget));
  }
  widgetsRoot.append(revenueCard(), digestCard(), followCard(), approvalCard());
}

function applyLayout() {
  const layout = localStorage.getItem("pa-layout") === "list" ? "list" : "grid";
  const density =
    localStorage.getItem("pa-density") === "compact"
      ? "compact"
      : "comfortable";
  widgetsRoot.classList.toggle("grid", layout === "grid");
  widgetsRoot.classList.toggle("list", layout === "list");
  widgetsRoot.classList.toggle("comfortable", density === "comfortable");
  widgetsRoot.classList.toggle("compact", density === "compact");
  layoutGrid?.setAttribute("aria-pressed", String(layout === "grid"));
  layoutList?.setAttribute("aria-pressed", String(layout === "list"));
  densityComfortable?.setAttribute(
    "aria-pressed",
    String(density === "comfortable"),
  );
  densityCompact?.setAttribute("aria-pressed", String(density === "compact"));
}

layoutGrid?.addEventListener("click", () => {
  localStorage.setItem("pa-layout", "grid");
  applyLayout();
});
layoutList?.addEventListener("click", () => {
  localStorage.setItem("pa-layout", "list");
  applyLayout();
});
densityComfortable?.addEventListener("click", () => {
  localStorage.setItem("pa-density", "comfortable");
  applyLayout();
});
densityCompact?.addEventListener("click", () => {
  localStorage.setItem("pa-density", "compact");
  applyLayout();
});

async function showHostVersion() {
  const version = await window.pa.invoke("host_version");
  versionNode.textContent = `Agent host ${version}`;
  await window.pa.invoke("note_displayed_host_version", { version });
}

async function showWidgets() {
  const parsed = JSON.parse(await window.pa.invoke("widgets"));
  if (!Array.isArray(parsed)) {
    throw new Error("widgets payload is invalid");
  }
  widgetPayload = parsed.filter(
    (item) =>
      item && typeof item.html === "string" && typeof item.title === "string",
  );
  widgetError = "";
  renderDashboard();
}

async function showRevenue() {
  try {
    const raw = await window.pa.invoke("revenue_status");
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.total !== "number"
    ) {
      throw new Error("the revenue sample did not include a total");
    }
    revenueState = { data: parsed, error: "" };
  } catch (error) {
    revenueState = { error: window.pa.explain(error, "Revenue") };
  }
  renderDashboard();
}

async function showMail() {
  try {
    const parsed = JSON.parse(await window.pa.invoke("mail_state"));
    if (!parsed || typeof parsed !== "object") {
      throw new Error("the mailbox payload was empty");
    }
    mailState = { data: parsed, error: "" };
  } catch (error) {
    mailState = { error: window.pa.explain(error, "Mail") };
  }
  renderDashboard();
}

async function showApprovals() {
  try {
    const parsed = JSON.parse(await window.pa.invoke("approvals"));
    if (!Array.isArray(parsed)) {
      throw new Error("the approvals payload was empty");
    }
    approvalState = { count: parsed.length, error: "" };
  } catch (error) {
    approvalState = {
      count: 0,
      error: window.pa.explain(error, "Approvals"),
    };
  }
  renderDashboard();
}

window.pa.onTheme(renderDashboard);
applyLayout();
showHostVersion().catch((error) => {
  versionNode.textContent = window.pa.explain(error, "Agent host");
});
showWidgets().catch((error) => {
  widgetPayload = [];
  widgetError = window.pa.explain(error, "Widgets");
  renderDashboard();
});
showRevenue();
showMail();
showApprovals();
