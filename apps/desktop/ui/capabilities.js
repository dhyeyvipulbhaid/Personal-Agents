const checks = document.getElementById("checks");
const plugins = document.getElementById("plugins");

function checkLine(check) {
  const cause = check.cause ? ` (${check.cause})` : "";
  return `${check.status}: ${check.name}${cause}`;
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
    plugins.append(article);
  }
  checks.replaceChildren();
  for (const check of list) {
    const item = document.createElement("li");
    const status = document.createElement("p");
    status.textContent = checkLine(check);
    const help = document.createElement("p");
    help.className = "muted";
    help.textContent = advice(check);
    item.append(status, help);
    checks.append(item);
  }
}

async function showChecks() {
  render(JSON.parse(await window.pa.invoke("capabilities")));
}

showChecks().catch((error) => {
  checks.textContent = window.pa.explain(error, "Capabilities");
});
