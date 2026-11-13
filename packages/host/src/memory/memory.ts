export type MemoryFact = {
  id: string;
  text: string;
  source: string;
  /** Set when reflect synthesized this row from other facts. */
  derived?: boolean;
  sourceFactIds?: string[];
  cited?: { id: string; text: string }[];
  kind?: string;
};

type StoredFact = MemoryFact & { tokens: string[] };

/** Keyword sample and per-task notes. Chat uses memory-bank instead of this store. */
export class MemoryStore {
  private facts: StoredFact[] = [];
  private nextId = 0;
  private readonly working = new Map<string, Map<string, string>>();

  remember(sessionId: string, text: string): MemoryFact {
    this.nextId += 1;
    const fact: StoredFact = {
      id: `fact-${this.nextId}`,
      text,
      source: sessionId,
      tokens: tokensOf(text),
    };
    this.facts.push(fact);
    return { id: fact.id, text: fact.text, source: fact.source };
  }

  recall(query: string): MemoryFact[] {
    const queryTokens = tokensOf(query);
    return this.facts
      .map((fact) => ({ fact, score: score(queryTokens, fact.tokens) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((item) => ({
        id: item.fact.id,
        text: item.fact.text,
        source: item.fact.source,
      }));
  }

  edit(id: string, text: string): void {
    const fact = this.facts.find((item) => item.id === id);
    if (!fact) {
      throw new Error("fact is missing");
    }
    fact.text = text;
    fact.tokens = tokensOf(text);
  }

  delete(id: string): void {
    this.facts = this.facts.filter((item) => item.id !== id);
  }

  view(): MemoryFact[] {
    return this.facts.map(({ id, text, source }) => ({ id, text, source }));
  }

  setWorking(taskId: string, key: string, value: string): void {
    const bag = this.working.get(taskId) ?? new Map<string, string>();
    bag.set(key, value);
    this.working.set(taskId, bag);
  }

  getWorking(taskId: string, key: string): string | undefined {
    return this.working.get(taskId)?.get(key);
  }
}

function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

function score(query: string[], fact: string[]): number {
  if (query.length === 0 || fact.length === 0) {
    return 0;
  }
  const factSet = new Set(fact);
  let overlap = 0;
  for (const token of query) {
    if (factSet.has(token)) {
      overlap += 1;
    }
  }
  const keyword = overlap / query.length;
  const vector = cosine(vectorOf(query), vectorOf(fact));
  return keyword + vector;
}

function vectorOf(tokens: string[]): number[] {
  const vector = new Array<number>(32).fill(0);
  for (const token of tokens) {
    let hash = 0;
    for (const char of token) {
      hash = (hash * 33 + char.charCodeAt(0)) % 32;
    }
    vector[hash] = (vector[hash] ?? 0) + 1;
  }
  return vector;
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}
