const list = document.getElementById("facts");
const status = document.getElementById("memory-status");
const observations = document.getElementById("observations");
const reflectStatus = document.getElementById("reflect-status");
const sweepList = document.getElementById("sweep-list");
const pageLabel = document.getElementById("page-label");
const encryptionStatus = document.getElementById("encryption-status");
const graphApi = globalThis.PersonalAgentsGraph;
const PAGE = 20;

let offset = 0;
let total = 0;
let paged = false;
let sweepReady = false;
let simulation = null;
let graphTexts = {};
let graphFrame = 0;
let selectedId = "";

function messageOf(error) {
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return "the agent host did not answer";
}

function isKeyError(detail) {
  return /encrypt|keychain|passphrase|key does not match|not a valid 32-byte/i.test(
    detail,
  );
}

function showGraphNote(detail) {
  const node = document.getElementById("graph-status");
  if (node) {
    node.textContent = detail;
  }
}

function noteKeyProblem(detail) {
  encryptionStatus.textContent = detail;
  showGraphNote(detail);
  const denied = /keychain access was denied/i.test(detail);
  const needsPassphrase = /enter the memory passphrase/i.test(detail);
  const missing = /missing from the macOS Keychain/i.test(detail);
  const restore = document.getElementById("restore-backup");
  if (restore) {
    restore.hidden = !(denied || missing || needsPassphrase);
  }
  const retry = document.getElementById("retry-keychain");
  if (retry) {
    retry.hidden = !denied;
  }
  const unlock = document.getElementById("unlock-passphrase");
  if (unlock) {
    unlock.hidden = !needsPassphrase;
  }
  const passphraseRow = document.getElementById("passphrase-row");
  if (passphraseRow) {
    passphraseRow.hidden = !(
      needsPassphrase || document.getElementById("use-passphrase").checked
    );
  }
  status.textContent = "";
  if (reflectStatus.textContent.startsWith("Reflecting")) {
    reflectStatus.textContent = "";
  }
}

function showMemoryError(error) {
  const detail = messageOf(error);
  if (isKeyError(detail)) {
    noteKeyProblem(detail);
    return;
  }
  status.textContent = window.pa.explain(error, "Memory");
}

function factLine(fact) {
  const line = document.createElement("span");
  line.textContent = `${fact.text} (source ${fact.source})`;
  return line;
}

function renderFacts(facts) {
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
    item.className = "fact-row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "fact-select";
    box.dataset.id = fact.id;
    box.setAttribute("aria-label", `Select ${fact.text}`);
    const body = document.createElement("div");
    body.append(factLine(fact));
    if (fact.kind) {
      const kind = document.createElement("span");
      kind.className = "chip";
      kind.textContent = fact.kind;
      body.append(" ", kind);
    }
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "ghost";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => startEdit(item, fact));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = "Delete";
    button.addEventListener("click", () => {
      window.pa
        .invoke("memory_delete", { id: fact.id })
        .then(() => Promise.all([showFacts(), showGraph()]))
        .catch((error) => showMemoryError(error));
    });
    item.append(box, body, edit, button);
    list.append(item);
  }
}

function startEdit(item, fact) {
  const input = document.createElement("input");
  input.value = fact.text;
  input.setAttribute("aria-label", "Edit fact");
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save edit";
  save.addEventListener("click", () => {
    window.pa
      .invoke("memory_update", { id: fact.id, text: input.value })
      .then(() => showFacts())
      .catch((error) => showMemoryError(error));
  });
  item.replaceChildren(input, save);
}

function renderObservations(items) {
  if (!observations) {
    return;
  }
  observations.replaceChildren();
  if (!Array.isArray(items) || items.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No derived observations yet.";
    observations.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("li");
    row.className = "observation";
    const badge = document.createElement("span");
    badge.className = "chip";
    badge.textContent = "Derived";
    const text = document.createElement("p");
    text.textContent = item.text;
    row.append(badge, text);
    const cited = Array.isArray(item.cited) ? item.cited : [];
    if (cited.length > 0) {
      const sources = document.createElement("ul");
      sources.className = "cited";
      for (const fact of cited) {
        const entry = document.createElement("li");
        entry.textContent = fact.text || fact.id;
        sources.append(entry);
      }
      row.append(sources);
    }
    observations.append(row);
  }
}

function pageQuery() {
  return {
    limit: PAGE,
    offset,
    query: document.getElementById("filter-query").value,
    entity: document.getElementById("filter-entity").value,
    kind: document.getElementById("filter-kind").value,
  };
}

function showPager() {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const current = Math.floor(offset / PAGE) + 1;
  pageLabel.textContent = paged ? `Page ${current} of ${pages}` : "";
  document.getElementById("prev-page").disabled = offset <= 0;
  document.getElementById("next-page").disabled = offset + PAGE >= total;
}

async function showFacts() {
  try {
    const raw = await window.pa.invoke("memory_page", pageQuery());
    const parsed = JSON.parse(raw);
    const facts = Array.isArray(parsed) ? parsed : parsed.facts;
    total = Array.isArray(parsed) ? facts.length : Number(parsed.total) || 0;
    paged = !Array.isArray(parsed);
    renderFacts(facts);
    showPager();
    return;
  } catch (error) {
    const detail = messageOf(error);
    if (!/unexpected command|Method not found/i.test(detail)) {
      showMemoryError(error);
      return;
    }
  }
  try {
    const facts = JSON.parse(await window.pa.invoke("memory_list"));
    total = Array.isArray(facts) ? facts.length : 0;
    paged = false;
    renderFacts(facts);
    showPager();
  } catch (error) {
    showMemoryError(error);
  }
}

async function showObservations() {
  try {
    renderObservations(
      JSON.parse(await window.pa.invoke("memory_observations")),
    );
  } catch (error) {
    const detail = messageOf(error);
    if (/unexpected command|Method not found/i.test(detail)) {
      return;
    }
    if (isKeyError(detail)) {
      noteKeyProblem(detail);
      return;
    }
    reflectStatus.textContent = detail;
  }
}

async function showSettings() {
  try {
    const settings = JSON.parse(await window.pa.invoke("memory_settings"));
    if (
      typeof settings.embeddingModel === "string" &&
      settings.embeddingModel
    ) {
      document.getElementById("embedding-model").value =
        settings.embeddingModel;
    }
    document.getElementById("include-observations").checked =
      settings.includeObservations !== false;
    const encrypt = document.getElementById("encrypt-memory");
    encrypt.checked = settings.encryptionEnabled === true;
    encrypt.disabled = false;
    const choice = document.getElementById("encryption-choice");
    if (choice) {
      choice.hidden = settings.encryptionPrompt !== true;
    }
    const restore = document.getElementById("restore-backup");
    if (settings.error && isKeyError(settings.error)) {
      noteKeyProblem(settings.error);
    } else if (settings.error) {
      encryptionStatus.textContent = settings.error;
      restore.hidden = true;
    } else if (settings.encryptionEnabled) {
      encryptionStatus.textContent =
        "Memory is encrypted. The key is in the macOS Keychain or Windows Credential Manager.";
      restore.hidden = true;
    } else {
      restore.hidden = true;
    }
  } catch (error) {
    const detail = messageOf(error);
    if (/unexpected command|Method not found/i.test(detail)) {
      return;
    }
    showMemoryError(error);
  }
}

function selectedIds() {
  return [...list.querySelectorAll(".fact-select:checked")].map(
    (box) => box.dataset.id,
  );
}

function renderSweep(result) {
  sweepList.replaceChildren();
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  if (candidates.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No junk facts.";
    sweepList.append(empty);
    document.getElementById("sweep-apply").hidden = true;
    sweepReady = false;
    return;
  }
  for (const item of candidates) {
    const row = document.createElement("li");
    row.textContent = `${item.text} (${item.reason})`;
    sweepList.append(row);
  }
  document.getElementById("sweep-apply").hidden = result.dryRun === false;
  sweepReady = result.dryRun !== false;
}

function drawGraph() {
  const canvas = document.getElementById("memory-graph");
  if (!canvas || !simulation) {
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(
    320,
    Math.floor(rect.width || canvas.clientWidth || 800),
  );
  const height = 480;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const styles = getComputedStyle(document.documentElement);
  context.clearRect(0, 0, width, height);
  context.fillStyle = styles.getPropertyValue("--sunken").trim() || "#f7f8fa";
  context.fillRect(0, 0, width, height);
  const originX = width / 2;
  const originY = height / 2;
  for (const edge of simulation.visibleEdges()) {
    const from = simulation.nodes.find((node) => node.id === edge.source);
    const to = simulation.nodes.find((node) => node.id === edge.target);
    if (!from || !to) {
      continue;
    }
    const start = simulation.toScreen(from.x, from.y);
    const end = simulation.toScreen(to.x, to.y);
    context.strokeStyle = graphApi.EDGE_COLORS[edge.type] || "#4b5160";
    context.lineWidth = edge.type === "derived" ? 1.5 : 1;
    context.beginPath();
    context.moveTo(originX + start.x, originY + start.y);
    context.lineTo(originX + end.x, originY + end.y);
    context.stroke();
  }
  for (const node of simulation.nodes) {
    const point = simulation.toScreen(node.x, node.y);
    const radius = simulation.radiusOf(node);
    context.beginPath();
    context.fillStyle = graphApi.recencyColor(node.recency);
    context.arc(originX + point.x, originY + point.y, radius, 0, Math.PI * 2);
    context.fill();
    if (node.id === selectedId) {
      context.strokeStyle =
        styles.getPropertyValue("--ink").trim() || "#1b1c21";
      context.lineWidth = 2;
      context.stroke();
    }
  }
}

function stopGraph() {
  if (graphFrame) {
    cancelAnimationFrame(graphFrame);
    graphFrame = 0;
  }
}

function runGraph() {
  stopGraph();
  const tick = () => {
    if (!simulation) {
      return;
    }
    simulation.step();
    const canvas = document.getElementById("memory-graph");
    const width = Math.max(
      320,
      Math.floor(canvas?.getBoundingClientRect().width || 800),
    );
    if (simulation.justSettled()) {
      simulation.fit(width, 480);
    }
    drawGraph();
    if (!simulation.isPaused() && !simulation.isSettled()) {
      graphFrame = requestAnimationFrame(tick);
    }
  };
  tick();
}

function renderLegend() {
  const legend = document.getElementById("graph-legend");
  const filters = document.getElementById("edge-filters");
  legend.replaceChildren();
  filters.replaceChildren();
  for (const item of graphApi.LEGEND) {
    const row = document.createElement("span");
    row.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    if (item.id === "recency") {
      swatch.style.background = `linear-gradient(90deg, ${graphApi.recencyColor(0)}, ${graphApi.recencyColor(1)})`;
    } else {
      swatch.style.background = graphApi.EDGE_COLORS[item.id];
    }
    row.append(swatch, document.createTextNode(item.label));
    legend.append(row);
    if (item.id === "recency") {
      continue;
    }
    const label = document.createElement("label");
    label.className = "check-line";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.dataset.edge = item.id;
    box.addEventListener("change", () => {
      simulation?.setEdgeEnabled(item.id, box.checked);
      drawGraph();
    });
    label.append(box, document.createTextNode(item.label));
    filters.append(label);
  }
}

async function showGraph() {
  if (!graphApi) {
    return;
  }
  try {
    const snapshot = JSON.parse(await window.pa.invoke("memory_graph"));
    graphTexts =
      snapshot.texts && typeof snapshot.texts === "object"
        ? snapshot.texts
        : {};
    if (simulation) {
      simulation.sync(snapshot);
    } else {
      simulation = graphApi.createSimulation(snapshot);
    }
    const toggle = document.getElementById("graph-toggle");
    if (!simulation.isPaused()) {
      toggle.textContent = "Pause";
    }
    if (!document.getElementById("edge-filters").childElementCount) {
      renderLegend();
    }
    const count = Array.isArray(snapshot.nodes) ? snapshot.nodes.length : 0;
    showGraphNote(count === 0 ? "No facts to draw yet." : "");
    if (simulation.isSettled()) {
      drawGraph();
    } else {
      runGraph();
    }
  } catch (error) {
    const detail = messageOf(error);
    if (/unexpected command|Method not found/i.test(detail)) {
      return;
    }
    showGraphNote(detail);
    if (isKeyError(detail)) {
      noteKeyProblem(detail);
      return;
    }
    status.textContent = detail;
  }
}

function openDetail(node) {
  const detail = document.getElementById("graph-detail");
  selectedId = node.id;
  const text = graphTexts[node.id] || node.label;
  detail.hidden = false;
  detail.replaceChildren();
  const title = document.createElement("h3");
  title.textContent = node.derived ? "Derived observation" : "Fact";
  const body = document.createElement("p");
  body.textContent = text;
  detail.append(title, body);
  drawGraph();
}

document.getElementById("remember").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const text = String(new FormData(form).get("text") ?? "").trim();
  status.textContent = "";
  window.pa
    .invoke("memory_remember", { text })
    .then(() => {
      form.reset();
      offset = 0;
      return showFacts();
    })
    .catch((error) => showMemoryError(error));
});

document.getElementById("filters").addEventListener("submit", (event) => {
  event.preventDefault();
  offset = 0;
  showFacts().catch((error) => showMemoryError(error));
});

document.getElementById("prev-page").addEventListener("click", () => {
  offset = Math.max(0, offset - PAGE);
  showFacts().catch((error) => showMemoryError(error));
});

document.getElementById("next-page").addEventListener("click", () => {
  if (offset + PAGE < total) {
    offset += PAGE;
    showFacts().catch((error) => showMemoryError(error));
  }
});

document.getElementById("delete-selected").addEventListener("click", () => {
  const ids = selectedIds().filter(Boolean);
  if (ids.length === 0) {
    status.textContent = "Select at least one fact.";
    return;
  }
  window.pa
    .invoke("memory_delete_many", { ids })
    .then(() => Promise.all([showFacts(), showGraph()]))
    .catch((error) => showMemoryError(error));
});

document.getElementById("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  window.pa
    .invoke("memory_save_settings", {
      embeddingModel: document.getElementById("embedding-model").value,
      includeObservations: document.getElementById("include-observations")
        .checked,
    })
    .then(() => {
      status.textContent = "Settings saved.";
    })
    .catch((error) => showMemoryError(error));
});

let encryptionBusy = false;
let ignoreEncryptChange = false;

function setEncryptChecked(box, checked) {
  ignoreEncryptChange = true;
  box.checked = checked;
  ignoreEncryptChange = false;
}

document
  .getElementById("encrypt-memory")
  .addEventListener("change", (event) => {
    const box = event.currentTarget;
    if (ignoreEncryptChange) {
      return;
    }
    if (encryptionBusy) {
      setEncryptChecked(box, true);
      return;
    }
    if (!box.checked) {
      encryptionBusy = true;
      encryptionStatus.textContent = "Restoring the plaintext backup…";
      window.pa
        .invoke("memory_disable_encryption")
        .then(async () => {
          encryptionStatus.textContent =
            "Memory is not encrypted. The plaintext backup was restored.";
          document.getElementById("encryption-choice").hidden = true;
          await showFacts();
          await showObservations();
          return showGraph();
        })
        .catch((error) => {
          setEncryptChecked(box, true);
          encryptionStatus.textContent = messageOf(error);
        })
        .finally(() => {
          encryptionBusy = false;
        });
      return;
    }
    const usePassphrase = document.getElementById("use-passphrase").checked;
    const passphrase = document.getElementById("memory-passphrase").value;
    if (usePassphrase && passphrase.trim().length < 8) {
      setEncryptChecked(box, false);
      encryptionStatus.textContent =
        "Use a passphrase of at least 8 characters.";
      return;
    }
    encryptionBusy = true;
    encryptionStatus.textContent = "Encrypting the memory file…";
    const command = usePassphrase
      ? "memory_enable_passphrase"
      : "memory_enable_encryption";
    const params = usePassphrase ? { passphrase } : undefined;
    window.pa
      .invoke(command, params)
      .then(async () => {
        document.getElementById("memory-passphrase").value = "";
        document.getElementById("encryption-choice").hidden = true;
        encryptionStatus.textContent = usePassphrase
          ? "Memory is encrypted with a passphrase."
          : "Memory is encrypted. The key is in the macOS Keychain or Windows Credential Manager.";
        await showFacts();
        return showGraph();
      })
      .catch((error) => {
        setEncryptChecked(box, false);
        const detail = messageOf(error);
        if (isKeyError(detail)) {
          noteKeyProblem(detail);
          return;
        }
        encryptionStatus.textContent = detail;
      })
      .finally(() => {
        encryptionBusy = false;
      });
  });

document.getElementById("passphrase-row").hidden = true;

document
  .getElementById("use-passphrase")
  .addEventListener("change", (event) => {
    document.getElementById("passphrase-row").hidden =
      !event.currentTarget.checked;
  });

document.getElementById("choice-stay-plain").addEventListener("click", () => {
  window.pa
    .invoke("memory_keep_plaintext")
    .then(async () => {
      document.getElementById("encryption-choice").hidden = true;
      setEncryptChecked(document.getElementById("encrypt-memory"), false);
      encryptionStatus.textContent =
        "Memory stays unencrypted. Saved facts were not deleted.";
      await showFacts();
      return showGraph();
    })
    .catch((error) => {
      encryptionStatus.textContent = messageOf(error);
    });
});

document.getElementById("choice-passphrase").addEventListener("click", () => {
  const passphrase = document.getElementById("memory-passphrase").value;
  if (passphrase.trim().length < 8) {
    encryptionStatus.textContent = "Use a passphrase of at least 8 characters.";
    return;
  }
  window.pa
    .invoke("memory_enable_passphrase", { passphrase })
    .then(async () => {
      document.getElementById("memory-passphrase").value = "";
      document.getElementById("encryption-choice").hidden = true;
      setEncryptChecked(document.getElementById("encrypt-memory"), true);
      encryptionStatus.textContent = "Memory is encrypted with a passphrase.";
      await showFacts();
      return showGraph();
    })
    .catch((error) => noteKeyProblem(messageOf(error)));
});

document.getElementById("retry-keychain").addEventListener("click", () => {
  encryptionStatus.textContent = "Asking the Keychain once…";
  window.pa
    .invoke("memory_retry_keychain")
    .then(async () => {
      document.getElementById("retry-keychain").hidden = true;
      encryptionStatus.textContent =
        "Memory is encrypted. The key is in the macOS Keychain or Windows Credential Manager.";
      await showFacts();
      await showObservations();
      return showGraph();
    })
    .catch((error) => noteKeyProblem(messageOf(error)));
});

document.getElementById("unlock-passphrase").addEventListener("click", () => {
  const passphrase = document.getElementById("memory-passphrase").value;
  window.pa
    .invoke("memory_unlock_passphrase", { passphrase })
    .then(async () => {
      document.getElementById("memory-passphrase").value = "";
      document.getElementById("unlock-passphrase").hidden = true;
      encryptionStatus.textContent = "Memory is unlocked.";
      await showFacts();
      await showObservations();
      return showGraph();
    })
    .catch((error) => noteKeyProblem(messageOf(error)));
});

document.getElementById("restore-backup").addEventListener("click", () => {
  encryptionStatus.textContent = "Restoring the plaintext backup…";
  window.pa
    .invoke("memory_restore_backup")
    .then(async () => {
      document.getElementById("restore-backup").hidden = true;
      const box = document.getElementById("encrypt-memory");
      box.checked = false;
      box.disabled = false;
      encryptionStatus.textContent =
        "Restored the plaintext backup. Memory is not encrypted.";
      status.textContent = "";
      await showFacts();
      await showObservations();
      return showGraph();
    })
    .catch((error) => {
      noteKeyProblem(messageOf(error));
    });
});

document.getElementById("reflect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = document.getElementById("reflect-query").value.trim();
  reflectStatus.textContent = "Reflecting…";
  window.pa
    .invoke("memory_reflect", query ? { query } : {})
    .then(async () => {
      await showObservations();
      reflectStatus.textContent = "";
      return showGraph();
    })
    .catch((error) => {
      reflectStatus.textContent = messageOf(error);
    });
});

document.getElementById("sweep-preview").addEventListener("click", () => {
  window.pa
    .invoke("memory_sweep", { dryRun: true })
    .then((raw) => renderSweep(JSON.parse(raw)))
    .catch((error) => showMemoryError(error));
});

document.getElementById("sweep-apply").addEventListener("click", () => {
  if (!sweepReady) {
    return;
  }
  window.pa
    .invoke("memory_sweep", { dryRun: false })
    .then((raw) => {
      renderSweep(JSON.parse(raw));
      return Promise.all([showFacts(), showGraph()]);
    })
    .catch((error) => showMemoryError(error));
});

document.getElementById("graph-toggle").addEventListener("click", () => {
  if (!simulation) {
    return;
  }
  const next = !simulation.isPaused();
  simulation.setPaused(next);
  const button = document.getElementById("graph-toggle");
  button.textContent = next ? "Resume" : "Pause";
  if (next) {
    stopGraph();
    drawGraph();
  } else {
    runGraph();
  }
});

document.getElementById("graph-refresh").addEventListener("click", () => {
  showGraph().catch((error) => showMemoryError(error));
});

const canvas = document.getElementById("memory-graph");
let pointer = null;

canvas.addEventListener("pointerdown", (event) => {
  if (!simulation) {
    return;
  }
  const bounds = canvas.getBoundingClientRect();
  const x = event.clientX - bounds.left - bounds.width / 2;
  const y = event.clientY - bounds.top - bounds.height / 2;
  const node = simulation.hit(x, y);
  pointer = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    nodeId: node?.id ?? "",
    moved: false,
  };
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  if (!simulation) {
    return;
  }
  const bounds = canvas.getBoundingClientRect();
  const x = event.clientX - bounds.left - bounds.width / 2;
  const y = event.clientY - bounds.top - bounds.height / 2;
  const hover = document.getElementById("graph-hover");
  if (!pointer) {
    const node = simulation.hit(x, y);
    if (!node) {
      hover.hidden = true;
      return;
    }
    hover.hidden = false;
    hover.textContent = graphTexts[node.id] || node.label;
    hover.style.left = `${event.clientX - bounds.left + 12}px`;
    hover.style.top = `${event.clientY - bounds.top + 12}px`;
    return;
  }
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  if (Math.hypot(dx, dy) > 3) {
    pointer.moved = true;
  }
  if (pointer.nodeId) {
    const world = simulation.screenToWorld(x, y);
    simulation.moveNode(pointer.nodeId, world.x, world.y, { reheat: true });
    if (!simulation.isSettled() && !graphFrame) {
      runGraph();
    }
  } else {
    simulation.panBy(dx, dy);
  }
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  hover.hidden = true;
  drawGraph();
});

canvas.addEventListener("pointerup", (event) => {
  if (!pointer || !simulation) {
    pointer = null;
    return;
  }
  if (!pointer.moved && pointer.nodeId) {
    const node = simulation.nodes.find((item) => item.id === pointer.nodeId);
    if (node) {
      openDetail(node);
    }
  }
  pointer = null;
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
});

canvas.addEventListener(
  "wheel",
  (event) => {
    if (!simulation) {
      return;
    }
    event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left - bounds.width / 2;
    const y = event.clientY - bounds.top - bounds.height / 2;
    simulation.zoomAt(event.deltaY < 0 ? 1.1 : 0.9, x, y);
    drawGraph();
  },
  { passive: false },
);

renderLegend();
showSettings().catch((error) => showMemoryError(error));
showFacts().catch((error) => showMemoryError(error));
showObservations().catch((error) => showMemoryError(error));
showGraph().catch((error) => showMemoryError(error));
