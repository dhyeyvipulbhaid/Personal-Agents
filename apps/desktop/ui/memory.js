const list = document.getElementById("facts");
const status = document.getElementById("memory-status");

function render(facts) {
  list.replaceChildren();
  if (!Array.isArray(facts) || facts.length === 0) {
    const item = document.createElement("li");
    item.textContent =
      "No saved facts yet. Save a fact here, or finish a chat reply and this page will list what was kept.";
    list.append(item);
    return;
  }
  for (const fact of facts) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = `${fact.text} (source ${fact.source})`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = "Delete";
    button.addEventListener("click", () => {
      window.pa
        .invoke("memory_delete", { id: fact.id })
        .then((raw) => render(JSON.parse(raw)))
        .catch((error) => {
          status.textContent = window.pa.explain(error, "Memory");
        });
    });
    item.append(text, button);
    list.append(item);
  }
}

async function showFacts() {
  render(JSON.parse(await window.pa.invoke("memory_list")));
}

document.getElementById("remember").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const text = String(data.get("text") ?? "").trim();
  status.textContent = "";
  window.pa
    .invoke("memory_remember", { text })
    .then(() => {
      form.reset();
      return showFacts();
    })
    .catch((error) => {
      status.textContent = window.pa.explain(error, "Memory");
    });
});

showFacts().catch((error) => {
  list.textContent = window.pa.explain(error, "Memory");
});
