/** Turns a model reply into HTML after escaping. The model cannot inject tags. */
function markdownToHtml(source) {
  const text = String(source ?? "").replaceAll("\r\n", "\n");
  const chunks = text.split("```");
  return chunks
    .map((chunk, index) => {
      if (index % 2 === 1) {
        const code = chunk.replace(/^[A-Za-z0-9_-]+\n/, "").replace(/\n$/, "");
        return `<pre><code>${escapeHtml(code)}</code></pre>`;
      }
      return chunk
        .split("\n")
        .map((line) => lineHtml(line))
        .join("");
    })
    .join("");
}

function lineHtml(line) {
  const heading = /^(#{1,3})\s+(.*)$/.exec(line);
  if (heading) {
    const tag = heading[1].length === 1 ? "h3" : "h4";
    return `<${tag}>${inlineHtml(heading[2])}</${tag}>`;
  }
  if (line.trim().length === 0) {
    return "";
  }
  return `<p>${inlineHtml(line)}</p>`;
}

function inlineHtml(line) {
  const escaped = escapeHtml(line);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

globalThis.markdownToHtml = markdownToHtml;
