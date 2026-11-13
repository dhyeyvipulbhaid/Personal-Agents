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

test("a page address is shown as a link named for the site", () => {
  const html = markdownToHtml(
    "The page is up.\n\n[https://apple.com/](https://apple.com/)\n\nAlso see https://www.apple.com/iphone.",
  );
  expect(html).toContain(
    '<a href="https://apple.com/" target="_blank" rel="noopener noreferrer">apple.com</a>',
  );
  expect(html).toContain(
    '<a href="https://www.apple.com/iphone" target="_blank" rel="noopener noreferrer">apple.com</a>',
  );
  expect(html).not.toContain("[https://apple.com/]");
  expect(html).not.toContain("<script");
});
