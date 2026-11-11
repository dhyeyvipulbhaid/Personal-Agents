import { expect, test } from "bun:test";

const markdownToHtml = new Function(
  `${await Bun.file(new URL("../ui/markdown.js", import.meta.url)).text()}\nreturn markdownToHtml;`,
)() as (source: string) => string;

test("markdown renders emphasis and code without raw html", () => {
  const html = markdownToHtml(
    "### Total\n\nThe **total** is `220`.\n\n```\n<p>no</p>\n```\n<script>alert(1)</script>",
  );
  expect(html).toContain("<h4>Total</h4>");
  expect(html).toContain("<strong>total</strong>");
  expect(html).toContain("<code>220</code>");
  expect(html).toContain("<pre><code>");
  expect(html).toContain("&lt;p&gt;no&lt;/p&gt;");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html.includes("<script>")).toBe(false);
});
