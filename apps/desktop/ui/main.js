const versionNode = document.getElementById("host-version");

async function showHostVersion() {
  const version = await window.__TAURI__.core.invoke("host_version");
  versionNode.textContent = `Agent host ${version}`;
  await window.__TAURI__.core.invoke("note_displayed_host_version", {
    version,
  });
}

showHostVersion().catch(() => {
  versionNode.textContent = "Agent host unavailable";
});
