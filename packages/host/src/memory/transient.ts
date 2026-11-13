/**
 * Page-state and assistant-meta lines that memory-bank's junkReason still
 * keeps. retain drops them here, and the Memory page sweep lists the ones
 * already stored. memory-bank does not classify these yet.
 */
export type TransientReason = "page-state" | "assistant-meta";

export function transientFactReason(text: string): TransientReason | null {
  const sentence = text.replace(/\s+/g, " ").trim();
  if (sentence.length === 0) {
    return null;
  }
  if (isPageState(sentence)) {
    return "page-state";
  }
  if (isAssistantMeta(sentence)) {
    return "assistant-meta";
  }
  return null;
}

function isPageState(text: string): boolean {
  const lower = text.toLowerCase();
  if (isNavigationState(lower)) {
    return true;
  }
  if (!namesAPage(lower)) {
    return false;
  }
  return isOpenPage(lower) || describesPageContents(lower);
}

function namesAPage(lower: string): boolean {
  return (
    /\b(?:website|web site|webpage|web page|homepage|home page)\b/.test(
      lower,
    ) || /\b(?:site|page)\b/.test(lower)
  );
}

function isOpenPage(lower: string): boolean {
  return /\b(?:is|are|was|were)\s+(?:now\s+)?open\b/.test(lower);
}

function describesPageContents(lower: string): boolean {
  return (
    /\b(?:features?|featuring|promotes?|promoting|includes?|including|displays?|displaying|shows?|showing|showcases?|showcasing)\b/.test(
      lower,
    ) ||
    /\bcontains the text\b/.test(lower) ||
    /\bthe text\b/.test(lower)
  );
}

function isNavigationState(lower: string): boolean {
  if (/\b(?:attempted|tried) to navigate\b/.test(lower)) {
    return true;
  }
  return (
    /\bassistant\b/.test(lower) &&
    /\b(?:stopped|blocked)\b/.test(lower) &&
    /\b(?:action|navigation)\b/.test(lower)
  );
}

function isAssistantMeta(text: string): boolean {
  if (!/^(?:the |this )?(?:assistant|language model|model|ai)\b/i.test(text)) {
    return false;
  }
  return /\b(?:said|says|responded|replied|told|explained|answered|fetched|fetch|did|didn't|did not|acknowledged|confirmed|noted|unable)\b/i.test(
    text,
  );
}
