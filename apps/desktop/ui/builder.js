const prompt = document.getElementById("builder-prompt");
const steps = document.getElementById("builder-steps");
const review = document.getElementById("builder-review");
const preview = document.getElementById("builder-preview");
const status = document.getElementById("builder-status");
let current = { template: "", prompt: "" };

function themed(html) {
  const theme = window.pa.theme() === "dark" ? "dark" : "light";
  return String(html).split("__PA_THEME__").join(theme);
}

function paintSteps(items) {
  for (const step of steps.querySelectorAll("li")) {
    const found = items.find(
      (item) => item.name.toLowerCase() === step.dataset.step,
    );
    step.dataset.state = found?.state || "";
  }
}

async function plan(request) {
  current = request;
  status.textContent = "";
  const parsed = JSON.parse(await window.pa.invoke("builder_plan", request));
  paintSteps(parsed.steps || []);
  const previewHtml = themed(parsed.preview || "");
  preview.srcdoc = `<!doctype html><html><body style="margin:16px;font:600 28px Inter,system-ui,sans-serif">${previewHtml}</body></html>`;
  review.hidden = false;
}

document.querySelectorAll("[data-template]").forEach((button) => {
  button.addEventListener("click", () => {
    const template = button.dataset.template;
    const text =
      template === "table"
        ? "show revenue as a table"
        : template === "alert"
          ? "alert when revenue drops"
          : "show total revenue as a big number";
    prompt.value = text;
    plan({ template, prompt: text }).catch((error) => {
      status.textContent = window.pa.explain(error, "Builder");
    });
  });
});

document.getElementById("builder-form").addEventListener("submit", (event) => {
  event.preventDefault();
  plan({ prompt: prompt.value }).catch((error) => {
    status.textContent = window.pa.explain(error, "Builder");
  });
});

document.getElementById("builder-install").addEventListener("click", () => {
  window.pa
    .invoke("builder_install", current)
    .then((raw) => {
      const parsed = JSON.parse(raw);
      paintSteps(parsed.steps || []);
      status.textContent =
        "Review finished. The install is waiting on Approvals. Open Approvals to allow it.";
    })
    .catch((error) => {
      status.textContent = window.pa.explain(error, "Builder");
    });
});

window.pa.onTheme(() => {
  if (!review.hidden && preview.getAttribute("srcdoc")) {
    plan(current).catch(() => {});
  }
});
