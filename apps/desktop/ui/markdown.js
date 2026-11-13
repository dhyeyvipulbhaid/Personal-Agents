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
  const pieces = line.split("`");
  return pieces
    .map((piece, index) => {
      if (index % 2 === 1) {
        return `<code>${escapeHtml(piece)}</code>`;
      }
      return linkify(piece);
    })
    .join("");
}

function linkify(text) {
  const pattern =
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>)\]]+/g;
  let html = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    html += emphasis(escapeHtml(text.slice(last, match.index)));
    const rawHref = match[1] ? match[2] : match[0];
    const href = webUrl(rawHref);
    if (!href) {
      html += emphasis(escapeHtml(match[0]));
    } else {
      const label = linkLabel(match[1] ?? rawHref, href);
      html += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
    }
    last = match.index + match[0].length;
  }
  html += emphasis(escapeHtml(text.slice(last)));
  return html;
}

function webUrl(raw) {
  const trimmed = String(raw ?? "").replace(/[.,;:!?]+$/g, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    return url.href;
  } catch {
    return "";
  }
}

function linkLabel(label, href) {
  const text = String(label ?? "").trim();
  try {
    const host = new URL(href).host.replace(/^www\./i, "");
    if (text.length === 0 || /^https?:\/\//i.test(text)) {
      return host;
    }
    return text;
  } catch {
    return text;
  }
}

function emphasis(escaped) {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
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
