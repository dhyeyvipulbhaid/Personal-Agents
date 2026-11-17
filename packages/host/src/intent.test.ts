import { expect, test } from "bun:test";
import { type IntentTool, routeIntent } from "./intent.ts";

const cases: {
  text: string;
  tool: IntentTool | null;
  url?: string;
  mode?: "force" | "narrow" | "none" | "model";
  source?: "keyword" | "semantic";
  trust?: boolean;
  query?: string;
}[] = [
  {
    text: "open example.com",
    tool: "browser.navigate",
    url: "https://example.com",
    source: "keyword",
  },
  {
    text: "please visit https://arxiv.org/abs/2609.09153",
    tool: "browser.navigate",
    url: "https://arxiv.org/abs/2609.09153",
    source: "keyword",
  },
  {
    text: "go to example.com/docs?q=1",
    tool: "browser.navigate",
    url: "https://example.com/docs?q=1",
    source: "keyword",
  },
  {
    text: "navigate to https://news.ycombinator.com/item?id=3",
    tool: "browser.navigate",
    url: "https://news.ycombinator.com/item?id=3",
    source: "keyword",
  },
  {
    text: "Open https://arxiv.org/abs/2609.09153?utm=1",
    tool: "browser.navigate",
    url: "https://arxiv.org/abs/2609.09153?utm=1",
    source: "keyword",
  },
  {
    text: "open https://example.com/search?q=cats&lang=en",
    tool: "browser.navigate",
    url: "https://example.com/search?q=cats&lang=en",
    source: "keyword",
  },
  {
    text: "summarise this paper https://arxiv.org/abs/2609.09153",
    tool: "browser.read",
    url: "https://arxiv.org/abs/2609.09153",
    source: "keyword",
  },
  {
    text: "summarize https://example.com/a/b?x=1.",
    tool: "browser.read",
    url: "https://example.com/a/b?x=1",
    source: "keyword",
  },
  {
    text: "explain this https://example.com/docs/intro",
    tool: "browser.read",
    url: "https://example.com/docs/intro",
    source: "keyword",
  },
  {
    text: "what does this say https://example.com/post",
    tool: "browser.read",
    url: "https://example.com/post",
    source: "keyword",
  },
  {
    text: "tl;dr https://example.com/paper",
    tool: "browser.read",
    url: "https://example.com/paper",
    source: "keyword",
  },
  {
    text: "tldr http://example.com/a?q=1",
    tool: "browser.read",
    url: "http://example.com/a?q=1",
    source: "keyword",
  },
  {
    text: "Read apple.com",
    tool: "browser.read",
    url: "https://apple.com",
    source: "keyword",
    trust: true,
  },
  {
    text: "please read https://example.com/a/b",
    tool: "browser.read",
    url: "https://example.com/a/b",
    source: "keyword",
    trust: true,
  },
  {
    text: "What is on the apple.com homepage?",
    tool: "browser.read",
    url: "https://apple.com",
    source: "keyword",
  },
  {
    text: "what does example.com say?",
    tool: "browser.read",
    url: "https://example.com",
    source: "keyword",
  },
  {
    text: "open example.com and tell me the page title.",
    tool: "browser.read",
    url: "https://example.com",
    source: "keyword",
  },
  {
    text: "What's the total in revenue.csv?",
    tool: "revenue.read",
    source: "keyword",
  },
  {
    text: "how much revenue did we book?",
    tool: "revenue.read",
    source: "keyword",
  },
  {
    text: "how's my inbox looking",
    tool: "mail.summary",
    source: "keyword",
  },
  {
    text: "any follow ups?",
    tool: "mail.summary",
    source: "keyword",
  },
  {
    text: "check the inbox",
    tool: "mail.summary",
    source: "keyword",
  },
  {
    text: "got any unread mail?",
    tool: "mail.summary",
    source: "keyword",
  },
  {
    text: "what do you remember about Maya?",
    tool: "memory.recall",
    source: "keyword",
    query: "what do you remember about Maya?",
  },
  {
    text: "show saved facts",
    tool: "memory.recall",
    source: "keyword",
  },
  {
    text: "take a screenshot",
    tool: "browser.screenshot",
    source: "keyword",
  },
  {
    text: "click the login button",
    tool: "browser.click",
    mode: "narrow",
    source: "keyword",
  },
  {
    text: "type hello into the search box",
    tool: "browser.type",
    mode: "narrow",
    source: "keyword",
  },
  {
    text: "walk me through https://arxiv.org/abs/2609.09153",
    tool: "browser.read",
    url: "https://arxiv.org/abs/2609.09153",
    source: "semantic",
  },
  {
    text: "give me a rundown of https://example.com/notes?id=4",
    tool: "browser.read",
    url: "https://example.com/notes?id=4",
    source: "semantic",
  },
  {
    text: "what did we make this quarter?",
    tool: "revenue.read",
    source: "semantic",
  },
  {
    text: "what did I tell you about the contract?",
    tool: "memory.recall",
    source: "semantic",
    query: "what did I tell you about the contract?",
  },
  {
    text: "open the sign in page",
    tool: "browser.navigate",
    mode: "narrow",
    source: "semantic",
  },
  {
    text: "hit the login button",
    tool: "browser.click",
    mode: "narrow",
    source: "semantic",
  },
  {
    text: "capture the page",
    tool: "browser.screenshot",
    source: "semantic",
  },
  { text: "hello", tool: null, mode: "none", source: "semantic" },
  { text: "thanks", tool: null, mode: "none", source: "semantic" },
  {
    text: "I like green tea",
    tool: null,
    mode: "none",
    source: "semantic",
  },
  {
    text: "Who is Pepper?",
    tool: null,
    mode: "none",
    source: "semantic",
  },
  {
    text: "what is the capital of France?",
    tool: null,
    mode: "none",
    source: "semantic",
  },
  {
    text: "the revenue total is 220",
    tool: null,
    mode: "none",
    source: "semantic",
  },
  {
    text: "remember the revenue total",
    tool: null,
    mode: "none",
    source: "semantic",
  },
  {
    text: "Open example.com, then summarize my mailbox.",
    tool: null,
    mode: "model",
    source: "keyword",
  },
  { text: "say hello", tool: null, mode: "none", source: "semantic" },
  { text: "ping", tool: null, mode: "none", source: "semantic" },
];

for (const item of cases) {
  test(item.text, () => {
    const route = routeIntent(item.text);
    expect(route.tool).toBe(item.tool);
    expect(route.source).toBe(item.source ?? "keyword");
    if (item.url) {
      expect(route.arguments.url).toBe(item.url);
      expect(route.mode).toBe("force");
    }
    if (item.mode) {
      expect(route.mode).toBe(item.mode);
    } else if (item.tool && item.mode === undefined && !item.url) {
      const narrow =
        item.tool === "browser.click" || item.tool === "browser.type";
      if (!narrow && item.text !== "open the sign in page") {
        expect(route.mode).toBe(item.tool ? "force" : "none");
      }
    }
    if (item.trust) {
      expect(route.trust).toBe(true);
    } else {
      expect(route.trust).toBe(false);
    }
    if (item.query) {
      expect(route.arguments.query).toBe(item.query);
    }
  });
}

test("a page question without a host is not a forced read", () => {
  const route = routeIntent("What is on apples main page?");
  expect(route.pageQuestion).toBe(true);
  expect(route.mode).not.toBe("force");
  expect(route.arguments.url).toBeUndefined();
});
