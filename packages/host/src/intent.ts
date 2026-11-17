/** Chat intent. Clear phrases match keywords. Everything else is scored against local example intents. */

export type IntentTool =
  | "browser.read"
  | "browser.navigate"
  | "browser.click"
  | "browser.type"
  | "browser.screenshot"
  | "revenue.read"
  | "mail.summary"
  | "memory.recall";

export type IntentMode = "force" | "narrow" | "none" | "model";

export type IntentRoute = {
  tool: IntentTool | null;
  arguments: Record<string, string>;
  mode: IntentMode;
  source: "keyword" | "semantic";
  trust: boolean;
  pageQuestion: boolean;
};

const FILE_TLDS = new Set([
  "csv",
  "txt",
  "json",
  "md",
  "png",
  "jpg",
  "jpeg",
  "pdf",
  "html",
  "js",
  "ts",
  "svg",
]);

const LOCAL_TOOLS = new Set<IntentTool>([
  "revenue.read",
  "mail.summary",
  "memory.recall",
]);

const ACCEPT = 0.52;

type Dim =
  | "summary"
  | "read"
  | "open"
  | "page"
  | "url"
  | "revenue"
  | "earn"
  | "quarter"
  | "mail"
  | "memory"
  | "click"
  | "type"
  | "shot"
  | "chat";

const SIGNALS: { dim: Dim; weight: number; pattern: RegExp }[] = [
  {
    dim: "summary",
    weight: 1.2,
    pattern:
      /\b(?:summari[sz]e\w*|gist|tldr|tl;dr|explain|rundown|recap|nutshell)\b/i,
  },
  {
    dim: "summary",
    weight: 1.2,
    pattern: /\b(?:break down|walk me through|what does .{0,48}say)\b/i,
  },
  { dim: "read", weight: 1, pattern: /\bread(?:ing)?\b/i },
  { dim: "open", weight: 1.1, pattern: /\b(?:open|visit|navigate)\b/i },
  { dim: "open", weight: 1.1, pattern: /\bgo to\b/i },
  {
    dim: "page",
    weight: 0.7,
    pattern: /\b(?:page|paper|article|homepage|website|site|link)\b/i,
  },
  { dim: "url", weight: 0.55, pattern: /https?:\/\/\S+/i },
  {
    dim: "url",
    weight: 0.45,
    pattern: /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|edu|gov)\b/i,
  },
  {
    dim: "revenue",
    weight: 1.5,
    pattern: /\b(?:revenue|sales|earnings|turnover)\b/i,
  },
  {
    dim: "earn",
    weight: 1,
    pattern: /\b(?:make|made|earn|earned|booked)\b/i,
  },
  { dim: "quarter", weight: 0.9, pattern: /\bquarter\b/i },
  {
    dim: "mail",
    weight: 1.5,
    pattern: /\b(?:inbox|mailbox|e-?mails?|digest|unread)\b/i,
  },
  { dim: "mail", weight: 1.5, pattern: /\bfollow[- ]?ups?\b/i },
  {
    dim: "memory",
    weight: 1.5,
    pattern: /\b(?:memory|remember(?:ed)?|recall)\b/i,
  },
  {
    dim: "memory",
    weight: 1.4,
    pattern: /\b(?:saved facts?|tell you|did i say)\b/i,
  },
  { dim: "click", weight: 1.4, pattern: /\b(?:click|press|tap|hit)\b/i },
  { dim: "type", weight: 1.3, pattern: /\b(?:type|fill in)\b/i },
  { dim: "shot", weight: 1.4, pattern: /\b(?:screenshots?|screen shot)\b/i },
  { dim: "shot", weight: 1.3, pattern: /\bcapture the page\b/i },
  {
    dim: "chat",
    weight: 1.2,
    pattern: /\b(?:hello|hi|hey|thanks|thank you)\b/i,
  },
  {
    dim: "chat",
    weight: 1.1,
    pattern: /\b(?:who is|capital of|i like|joke)\b/i,
  },
];

const CENTROIDS: Record<IntentTool | "none", Partial<Record<Dim, number>>> = {
  "browser.read": { summary: 1, read: 0.8, page: 0.7, url: 0.5 },
  "browser.navigate": { open: 1, page: 0.35, url: 0.45 },
  "browser.click": { click: 1 },
  "browser.type": { type: 1 },
  "browser.screenshot": { shot: 1 },
  "revenue.read": { revenue: 1, earn: 0.85, quarter: 0.7 },
  "mail.summary": { mail: 1 },
  "memory.recall": { memory: 1 },
  none: { chat: 1 },
};

export function routeIntent(text: string): IntentRoute {
  const keyword = keywordRoute(text);
  if (keyword) {
    return keyword;
  }
  return semanticRoute(text);
}

function keywordRoute(text: string): IntentRoute | null {
  const trimmed = text.trim();
  const url = extractUrl(trimmed);
  if (
    /^(?:please\s+)?(?:take|grab|capture)\s+(?:a\s+)?(?:screen\s*shot|screenshot)\b/i.test(
      trimmed,
    )
  ) {
    return finish(trimmed, {
      tool: "browser.screenshot",
      arguments: {},
      mode: "force",
      source: "keyword",
    });
  }
  if (/^(?:please\s+)?(?:click|press|tap)\b/i.test(trimmed)) {
    return finish(trimmed, {
      tool: "browser.click",
      arguments: {},
      mode: "narrow",
      source: "keyword",
    });
  }
  if (/^(?:please\s+)?(?:type|fill in)\b/i.test(trimmed)) {
    return finish(trimmed, {
      tool: "browser.type",
      arguments: {},
      mode: "narrow",
      source: "keyword",
    });
  }
  const local = localIntent(trimmed);
  if (
    url &&
    mentionsLocalData(trimmed) &&
    (hasReadCue(trimmed) ||
      /^(?:please\s+)?(?:open|visit|go to|navigate to)\b/i.test(trimmed))
  ) {
    return finish(trimmed, {
      tool: null,
      arguments: {},
      mode: "model",
      source: "keyword",
    });
  }
  if (url && hasReadCue(trimmed)) {
    return finish(trimmed, {
      tool: "browser.read",
      arguments: { url },
      mode: "force",
      source: "keyword",
      trust: bareRead(trimmed),
    });
  }
  if (url && openOnly(trimmed)) {
    return finish(trimmed, {
      tool: "browser.navigate",
      arguments: { url },
      mode: "force",
      source: "keyword",
    });
  }
  if (local) {
    return finish(trimmed, {
      tool: local,
      arguments: local === "memory.recall" ? { query: trimmed } : {},
      mode: "force",
      source: "keyword",
    });
  }
  return null;
}

function semanticRoute(text: string): IntentRoute {
  const trimmed = text.trim();
  const vector = embed(trimmed);
  const url = extractUrl(trimmed);
  if (url && (vector.get("summary") || vector.get("read"))) {
    return finish(trimmed, {
      tool: "browser.read",
      arguments: { url },
      mode: "force",
      source: "semantic",
      trust: bareRead(trimmed),
    });
  }
  let best: IntentTool | "none" = "none";
  let bestScore = 0;
  let second = 0;
  for (const intent of Object.keys(CENTROIDS) as (IntentTool | "none")[]) {
    const score = cosine(vector, CENTROIDS[intent]);
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = intent;
    } else if (score > second) {
      second = score;
    }
  }
  if (best !== "none" && second >= ACCEPT && bestScore - second < 0.06) {
    return finish(trimmed, {
      tool: null,
      arguments: {},
      mode: "model",
      source: "semantic",
    });
  }
  if (best === "none" || bestScore < ACCEPT) {
    return finish(trimmed, {
      tool: null,
      arguments: {},
      mode: "none",
      source: "semantic",
    });
  }
  if (LOCAL_TOOLS.has(best) && (!asksFor(trimmed) || !allowLocal(trimmed))) {
    return finish(trimmed, {
      tool: null,
      arguments: {},
      mode: "none",
      source: "semantic",
    });
  }
  if (best === "browser.read" || best === "browser.navigate") {
    if (!url) {
      return finish(trimmed, {
        tool: best,
        arguments: {},
        mode: "narrow",
        source: "semantic",
      });
    }
    return finish(trimmed, {
      tool: best,
      arguments: { url },
      mode: "force",
      source: "semantic",
    });
  }
  if (best === "browser.click" || best === "browser.type") {
    return finish(trimmed, {
      tool: best,
      arguments: {},
      mode: "narrow",
      source: "semantic",
    });
  }
  if (best === "browser.screenshot") {
    return finish(trimmed, {
      tool: best,
      arguments: {},
      mode: "force",
      source: "semantic",
    });
  }
  return finish(trimmed, {
    tool: best,
    arguments: best === "memory.recall" ? { query: trimmed } : {},
    mode: "force",
    source: "semantic",
  });
}

function finish(
  text: string,
  route: Omit<IntentRoute, "pageQuestion" | "trust"> & { trust?: boolean },
): IntentRoute {
  return {
    tool: route.tool,
    arguments: route.arguments,
    mode: route.mode,
    source: route.source,
    trust: route.trust ?? false,
    pageQuestion: isPageQuestion(text),
  };
}

function hasReadCue(text: string): boolean {
  return (
    /\b(?:summari[sz]e\w*|gist|explain|tldr|tl;dr|tl\s*;?\s*dr)\b/i.test(
      text,
    ) ||
    /\bwhat does\b/i.test(text) ||
    /\bwhat(?:'s| is) on\b/i.test(text) ||
    /\b(?:read|reading)\b/i.test(text) ||
    /\bpage title\b/i.test(text) ||
    /\btell me (?:the|what|about)\b/i.test(text) ||
    /\bbreak down\b/i.test(text)
  );
}

function bareRead(text: string): boolean {
  return /^(?:please\s+)?read\s+\S+\s*[.!?]*$/i.test(text.trim());
}

function openOnly(text: string): boolean {
  const trimmed = text.trim().replace(/[.!?]+$/g, "");
  return /^(?:please\s+)?(?:open|visit|go to|navigate to)\s+\S+$/i.test(
    trimmed,
  );
}

function asksFor(text: string): boolean {
  const question = text.trim().toLowerCase();
  if (question.endsWith("?")) {
    return true;
  }
  return (
    /^(?:please\s+)?(?:what|how|show|list|which|where|check|any|do|did|can|could|summarize|summarise|get|pull|give|tell)\b/.test(
      question,
    ) ||
    /\b(?:how much|how many|what's|how's|what're|is there|are there|show me)\b/.test(
      question,
    )
  );
}

function statesFact(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith("?")) {
    return false;
  }
  return /^(?:the|a|an|remember)\b/i.test(trimmed);
}

function allowLocal(text: string): boolean {
  return !statesFact(text);
}

function mentionsLocalData(text: string): boolean {
  const question = text.toLowerCase();
  return (
    /\b(?:revenue(?:\.csv)?|sales|earnings)\b/.test(question) ||
    /\b(?:inbox|mailbox|e-?mails?|digest|unread)\b/.test(question) ||
    /\bfollow[- ]?ups?\b/.test(question) ||
    /\b(?:memory|remember(?:ed)?|recall|saved facts?)\b/.test(question)
  );
}

function localIntent(
  text: string,
): "revenue.read" | "mail.summary" | "memory.recall" | null {
  if (!asksFor(text) || !allowLocal(text)) {
    return null;
  }
  const question = text.toLowerCase();
  const revenue = /\b(?:revenue(?:\.csv)?|sales|earnings)\b/.test(question);
  const mail =
    /\b(?:inbox|mailbox|e-?mails?|digest|unread)\b/.test(question) ||
    /\bfollow[- ]?ups?\b/.test(question);
  const memory = /\b(?:memory|remember(?:ed)?|recall|saved facts?)\b/.test(
    question,
  );
  const hits = [revenue, mail, memory].filter(Boolean).length;
  if (hits !== 1) {
    return null;
  }
  if (revenue) {
    return "revenue.read";
  }
  if (mail) {
    return "mail.summary";
  }
  return "memory.recall";
}

export function isPageQuestion(text: string): boolean {
  return (
    /\b(?:what(?:'s| is) on|what does|what(?:'s| is) (?:the )?(?:latest|current))\b/i.test(
      text,
    ) && /\b(?:page|site|website|homepage)\b/i.test(text)
  );
}

export function extractUrl(text: string): string | null {
  const explicit = /https?:\/\/[^\s<>"']+/i.exec(text);
  if (explicit?.[0]) {
    return cleanUrl(explicit[0]);
  }
  const bare = /\b(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi;
  for (const match of text.matchAll(bare)) {
    const start = match.index ?? 0;
    if (start > 0 && text[start - 1] === "@") {
      continue;
    }
    const raw = match[0] ?? "";
    const host = raw.replace(/^www\./i, "").split("/")[0] ?? "";
    const tld = host.split(".").at(-1)?.toLowerCase() ?? "";
    if (FILE_TLDS.has(tld) && !raw.includes("/")) {
      continue;
    }
    return cleanUrl(`https://${raw}`);
  }
  return null;
}

function cleanUrl(raw: string): string {
  return raw.replace(/[.,;:!?)>\]]+$/g, "");
}

function embed(text: string): Map<Dim, number> {
  const vector = new Map<Dim, number>();
  for (const signal of SIGNALS) {
    if (signal.pattern.test(text)) {
      vector.set(
        signal.dim,
        Math.max(vector.get(signal.dim) ?? 0, signal.weight),
      );
    }
  }
  return vector;
}

function cosine(
  message: Map<Dim, number>,
  centroid: Partial<Record<Dim, number>>,
): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (const value of message.values()) {
    left += value * value;
  }
  for (const [dim, value] of Object.entries(centroid) as [Dim, number][]) {
    right += value * value;
    dot += value * (message.get(dim) ?? 0);
  }
  if (left === 0 || right === 0) {
    return 0;
  }
  return dot / (Math.sqrt(left) * Math.sqrt(right));
}
