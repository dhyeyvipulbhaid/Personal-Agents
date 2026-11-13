import { expect, test } from "bun:test";
import { Approvals } from "../approvals/approvals.ts";
import { READABLE_CHAR_LIMIT, readableFromHtml } from "./read.ts";
import { BrowserSession } from "./session.ts";

const page = `<!doctype html>
<html>
  <head><title>Example Domain</title><style>body{color:red}</style></head>
  <body>
    <nav>Skip this nav</nav>
    <main>
      <h1>Example Domain</h1>
      <h2>Use in documents</h2>
      <p>This domain is for use in illustrative examples in documents.</p>
      <script>secret()</script>
    </main>
    <footer>Ignore the footer</footer>
  </body>
</html>`;

test("readable text keeps the title, headings, and main text", () => {
  const read = readableFromHtml(page);
  expect(read.title).toBe("Example Domain");
  expect(read.headings).toEqual(["Example Domain", "Use in documents"]);
  expect(read.text).toContain(
    "This domain is for use in illustrative examples in documents.",
  );
  expect(read.text).not.toContain("Skip this nav");
  expect(read.text).not.toContain("Ignore the footer");
  expect(read.text).not.toContain("secret()");
});

test("readable text decodes entities and trims to the model limit", () => {
  const long = "word ".repeat(4_000);
  const read = readableFromHtml(
    `<title>A &amp; B</title><main><p>${long}</p><p>Tom&#39;s notes</p></main>`,
  );
  expect(read.title).toBe("A & B");
  expect(read.text.length).toBeLessThanOrEqual(READABLE_CHAR_LIMIT);
  expect(read.text.endsWith("...")).toBe(true);
  expect(read.text).not.toContain("Tom's notes");
});

test("nav labels are dropped from the page text", () => {
  const read = readableFromHtml(
    "<title>Apple</title><main><h1>Home</h1><p>Apple HomeView is designed for life at home. Learn more Buy Gifts Item 1 Item 2 Stream now</p></main>",
  );
  expect(read.text).toContain("Apple HomeView is designed for life at home.");
  expect(read.text).not.toMatch(/\blearn more\b/i);
  expect(read.text).not.toMatch(/\bbuy\b/i);
  expect(read.text).not.toMatch(/\bitem 1\b/i);
  expect(read.text).not.toMatch(/\bstream now\b/i);
});

test("a page without main still returns the body text", () => {
  const read = readableFromHtml(
    "<title>Notes</title><body><h1>Notes</h1><p>Bring the ledger.</p></body>",
  );
  expect(read.headings).toEqual(["Notes"]);
  expect(read.text).toContain("Bring the ledger.");
});

test("a denied read does not fetch the page", async () => {
  const approvals = new Approvals(() => {});
  const session = new BrowserSession(approvals);
  let fetches = 0;
  const pending = session.read("https://example.test/story", async () => {
    fetches += 1;
    return "<title>Secret</title><main><p>hidden words</p></main>";
  });
  approvals.deny(approvals.pending()[0]?.id ?? "");
  const result = await pending;
  expect(fetches).toBe(0);
  expect(result.opened).toBe(false);
  expect(result.text).toBe("");
  expect(result.title).toBe("");
});

test("stopping a visit cancels the read and does not fetch", async () => {
  const approvals = new Approvals(() => {});
  const session = new BrowserSession(approvals);
  let fetches = 0;
  const pending = session.read("https://example.test/story", async () => {
    fetches += 1;
    return "<title>Secret</title><main><p>hidden words</p></main>";
  });
  approvals.cancelTask("browser");
  const result = await pending;
  expect(fetches).toBe(0);
  expect(result.cancelled).toBe(true);
  expect(result.opened).toBe(false);
  expect(result.text).toBe("");
});

test("an approved read returns the text and the next read of that site does not ask again", async () => {
  const approvals = new Approvals(() => {});
  const session = new BrowserSession(approvals);
  const html =
    "<title>Example Domain</title><main><h1>Example Domain</h1><p>illustrative examples</p></main>";
  const first = session.read("https://example.test/a", async () => html);
  approvals.approve(approvals.pending()[0]?.id ?? "");
  const result = await first;
  expect(result.opened).toBe(true);
  expect(result.title).toBe("Example Domain");
  expect(result.headings).toEqual(["Example Domain"]);
  expect(result.text).toContain("illustrative examples");
  const before = approvals.pending().length;
  const second = await session.read("https://example.test/b", async () => html);
  expect(approvals.pending().length).toBe(before);
  expect(second.text).toContain("illustrative examples");
});
