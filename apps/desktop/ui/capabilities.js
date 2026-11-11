const checks = document.getElementById("checks");
const plugins = document.getElementById("plugins");

function shorten(path) {
  return path
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~")
    .replace(/^C:\\Users\\[^\\]+/i, "~");
}

function labelFor(check) {
  const name = check.name ?? "";
  if (name.startsWith("folder ")) {
    return { title: "Folder", detail: shorten(name.slice("folder ".length)) };
  }
  if (name.startsWith("browser ")) {
    return { title: name.slice("browser ".length), detail: check.cause || "" };
  }
  if (name.startsWith("model ")) {
    return { title: "Model", detail: name.slice("model ".length) };
  }
  if (name === "remote debugging") {
    return { title: "Remote debugging", detail: check.cause || "" };
  }
  if (name === "ollama") {
    return { title: "Ollama", detail: check.cause || "" };
  }
  if (name === "outlook") {
    return { title: "Outlook", detail: check.cause || "" };
  }
  return { title: name, detail: check.cause || "" };
}

function advice(check) {
  if (typeof check.advice === "string" && check.advice.length > 0) {
    return check.advice;
  }
  if (check.status === "available") {
    return "This is ready on this machine.";
  }
  if (check.cause) {
    return `Blocked because ${check.cause}. Fix that, then reopen this page.`;
  }
  return "This check did not pass. Reopen the page after the dependency is installed.";
}

function render(report) {
  const list = Array.isArray(report) ? report : (report.checks ?? []);
  const cards = Array.isArray(report?.plugins) ? report.plugins : [];
  plugins.replaceChildren();
  for (const card of cards) {
    const article = document.createElement("article");
    article.className = "card";
    const head = document.createElement("header");
    head.className = "card-head";
    const dot = document.createElement("span");
    dot.className = `dot ${card.health === "healthy" ? "good" : "bad"}`;
    const title = document.createElement("h2");
    title.textContent = card.name;
    head.append(dot, title);
    const summary = document.createElement("p");
    summary.textContent = card.summary || "";
    article.append(head, summary);
    for (const permission of card.permissions ?? []) {
      const line = document.createElement("p");
      line.textContent = permission;
      article.append(line);
    }
    if (card.connect) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Connect Outlook";
      button.addEventListener("click", () => {
        button.disabled = true;
        window.pa
          .invoke("mail_connect")
          .then(() => {
            button.textContent = "Waiting in Approvals";
          })
          .catch((error) => {
            button.disabled = false;
            button.textContent = "Connect Outlook";
            const note = document.createElement("p");
            note.className = "notice";
            note.textContent = window.pa.explain(error, "Outlook");
            article.append(note);
          });
      });
      article.append(button);
    }
    plugins.append(article);
  }
  checks.replaceChildren();
  for (const check of list) {
    const item = document.createElement("li");
    item.className = "check-row";
    const chip = document.createElement("span");
    const ready = check.status === "available";
    chip.className = `chip ${ready ? "ready" : "blocked"}`;
    chip.textContent = ready ? "Ready" : "Blocked";
    const label = labelFor(check);
    const text = document.createElement("div");
    const title = document.createElement("p");
    title.textContent = label.title;
    text.append(title);
    if (label.detail) {
      const detail = document.createElement("p");
      detail.className = "muted";
      detail.textContent = label.detail;
      text.append(detail);
    }
    const helpText = advice(check);
    if (!ready && helpText) {
      const help = document.createElement("p");
      help.className = "muted";
      help.textContent = helpText;
      text.append(help);
    }
    item.append(chip, text);
    checks.append(item);
  }
}

async function showChecks() {
  render(JSON.parse(await window.pa.invoke("capabilities")));
}

showChecks().catch((error) => {
  checks.textContent = window.pa.explain(error, "Capabilities");
});
