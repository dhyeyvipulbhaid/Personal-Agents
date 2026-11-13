/** Room left for the rest of a qwen3:4b or qwen3:8b chat turn. */
export const READABLE_CHAR_LIMIT = 6_000;

export type ReadablePage = {
  title: string;
  headings: string[];
  text: string;
};

export function readableFromHtml(html: string): ReadablePage {
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(cleaned);
  const title = titleMatch ? plain(titleMatch[1] ?? "") : "";
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(cleaned);
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(cleaned);
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(cleaned);
  const scope = main?.[1] ?? article?.[1] ?? body?.[1] ?? cleaned;
  const headings: string[] = [];
  for (const match of scope.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)) {
    const heading = plain(match[1] ?? "");
    if (heading.length > 0) {
      headings.push(heading.slice(0, 200));
    }
    if (headings.length >= 12) {
      break;
    }
  }
  const prose = scope
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, " ");
  return {
    title,
    headings: headings.filter((heading) => !navNoise(heading)),
    text: trimToLimit(withoutNavNoise(plain(prose))),
  };
}

function navNoise(value: string): boolean {
  return /^(?:learn more|buy|shop now|stream now|watch now|watch the film|order now|pre-order|explore|see more)$/i.test(
    value.trim(),
  );
}

function withoutNavNoise(text: string): string {
  return text
    .replace(
      /\b(?:learn more|buy|shop now|stream now|watch now|watch the film|order now|pre-order|explore|see more)\b/gi,
      " ",
    )
    .replace(/\bitem\s+\d+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function plain(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, num: string) =>
      String.fromCodePoint(Number.parseInt(num, 10)),
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function trimToLimit(value: string): string {
  if (value.length <= READABLE_CHAR_LIMIT) {
    return value;
  }
  const room = READABLE_CHAR_LIMIT - 3;
  const sliced = value.slice(0, room);
  const space = sliced.lastIndexOf(" ");
  const cut = space > room * 0.6 ? sliced.slice(0, space) : sliced;
  return `${cut.trimEnd()}...`;
}
