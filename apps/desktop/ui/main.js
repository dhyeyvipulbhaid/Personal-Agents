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
let browserState = null;
let browserLocked = "";
let browserStopping = false;
let browserTimer = 0;
let browserOnScreen = true;

function themedHtml(html, theme) {
  const safe = theme === "dark" ? "dark" : "light";
  return String(html).split("__PA_THEME__").join(safe);
}

function ago(value) {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) {
    return "Updated";
  }
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) {
    return "Updated just now";
  }
  if (minutes === 1) {
    return "Updated 1 min ago";
  }
  if (minutes < 60) {
    return `Updated ${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `Updated ${hours} hr ago`;
  }
  return `Updated ${Math.round(hours / 24)} days ago`;
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
  frame.srcdoc = window.pa.frameDocument(
    themedHtml(widget.html, window.pa.theme()),
    window.pa.theme(),
  );
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
    data.lastRefresh ? ago(data.lastRefresh) : "",
  );
  const total = document.createElement("p");
  total.className = "total";
  total.id = "revenue-status";
  total.textContent = String(data.total);
  article.append(total);
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

function browserCard() {
  const article = card("Browser activity", "good", "");
  article.id = "browser-activity";
  const state = browserState;
  if (!state || (!state.active && !state.pendingApproval)) {
    const note = document.createElement("p");
    note.className = "muted";
    note.id = "browser-idle";
    const recent = Array.isArray(state?.recentActions)
      ? state.recentActions.slice(0, 5)
      : [];
    if (state?.error) {
      note.className = "notice";
      note.textContent = state.error;
    } else {
      note.textContent =
        recent.length === 0
          ? "No browser activity yet."
          : "Recent browser actions";
    }
    article.append(note);
    if (recent.length > 0) {
      const list = document.createElement("ul");
      list.className = "plain-list";
      for (const action of recent) {
        const item = document.createElement("li");
        const anchor = link(
          "activity.html",
          action.summary || "Browser action",
        );
        item.append(anchor);
        list.append(item);
      }
      article.append(list);
    }
    return article;
  }
  if (state.pendingApproval && browserLocked !== state.pendingApproval.id) {
    const summary = document.createElement("p");
    summary.id = "browser-pending";
    summary.textContent = state.pendingApproval.summary;
    const row = actions(
      button("Approve", "", () =>
        decideBrowser(
          state.pendingApproval.id,
          "approve",
          state.pendingApproval.summary,
        ),
      ),
      button("Deny", "danger", () =>
        decideBrowser(
          state.pendingApproval.id,
          "deny",
          state.pendingApproval.summary,
        ),
      ),
    );
    article.append(summary, row);
    return article;
  }
  if (browserLocked && state.pendingApproval) {
    const status = document.createElement("p");
    status.className = "muted";
    status.id = "browser-status";
    status.textContent = browserLockedText;
    article.append(status);
    return article;
  }
  if (browserStopping) {
    article.append(
      siteLine(state),
      stepLine(state),
      actions(disabledButton("Stopping…")),
    );
    return article;
  }
  if (state.thumbnail) {
    const img = document.createElement("img");
    img.className = "browser-thumb";
    img.alt = state.site || "Browser";
    img.src = state.thumbnail.startsWith("data:")
      ? state.thumbnail
      : `data:image/jpeg;base64,${state.thumbnail}`;
    article.append(img);
  }
  article.append(
    siteLine(state),
    stepLine(state),
    actions(button("Stop", "danger", () => stopBrowser())),
  );
  return article;
}

function siteLine(state) {
  const site = document.createElement("p");
  site.id = "browser-site";
  site.textContent = state.site || state.url || "";
  return site;
}

function stepLine(state) {
  const step = document.createElement("p");
  step.className = "muted";
  step.id = "browser-step";
  step.textContent = state.currentStep || "";
  return step;
}

function disabledButton(label) {
  const node = document.createElement("button");
  node.type = "button";
  node.disabled = true;
  node.textContent = label;
  return node;
}

let browserLockedText = "";

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

function decideBrowser(id, action, summary) {
  if (browserLocked) {
    return;
  }
  browserLocked = id;
  browserLockedText = action === "deny" ? "Denied" : progressLine(summary);
  renderDashboard();
  window.pa
    .invoke("chat_approve", { id, action })
    .then(() => showBrowser())
    .catch((error) => {
      browserLocked = "";
      browserState = {
        ...(browserState || {}),
        error: window.pa.explain(error, "Browser"),
      };
      renderDashboard();
    });
}

function stopBrowser() {
  if (browserStopping) {
    return;
  }
  browserStopping = true;
  renderDashboard();
  window.pa
    .invoke("browser_stop")
    .then(() => {
      browserStopping = false;
      return showBrowser();
    })
    .catch((error) => {
      browserStopping = false;
      browserState = {
        ...(browserState || {}),
        error: window.pa.explain(error, "Browser"),
      };
      renderDashboard();
    });
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
  widgetsRoot.append(
    browserCard(),
    revenueCard(),
    digestCard(),
    followCard(),
    approvalCard(),
  );
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
document.addEventListener("pa-font", renderDashboard);
applyLayout();
showWidgets().catch((error) => {
  widgetPayload = [];
  widgetError = window.pa.explain(error, "Widgets");
  renderDashboard();
});
showRevenue();
showMail();
function pageVisible() {
  return document.visibilityState !== "hidden";
}

async function showBrowser() {
  try {
    const parsed = JSON.parse(
      await window.pa.invoke("browser_activity", {
        visible: pageVisible() && browserOnScreen,
      }),
    );
    if (parsed && browserLocked && !parsed.pendingApproval) {
      browserLocked = "";
    }
    browserState = parsed;
  } catch (error) {
    browserState = { error: window.pa.explain(error, "Browser") };
  }
  renderDashboard();
}

function armBrowserWatch() {
  window.clearInterval(browserTimer);
  if (!pageVisible()) {
    window.pa.invoke("browser_activity", { visible: false }).catch(() => {});
    return;
  }
  browserTimer = window.setInterval(() => {
    showBrowser().catch(() => {});
  }, 1000);
  showBrowser().catch(() => {});
}

document.addEventListener("visibilitychange", () => {
  armBrowserWatch();
});

const browserWatch = new IntersectionObserver((entries) => {
  browserOnScreen = entries.some((entry) => entry.isIntersecting);
  armBrowserWatch();
});

showApprovals();
armBrowserWatch();
if (widgetsRoot) {
  browserWatch.observe(widgetsRoot);
}
