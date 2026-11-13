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
  const aboutAPage =
    /\b(?:website|web site|webpage|web page|homepage|home page)\b/.test(
      lower,
    ) || /\b(?:site|page) is open\b/.test(lower);
  const showsContent =
    /\b(?:is|are|was|were)\s+open\b/.test(lower) ||
    /\b(?:displays?|displaying|shows?|showing|features?|featuring)\b/.test(
      lower,
    ) ||
    /\bcontains the text\b/.test(lower) ||
    /\bthe text\b/.test(lower);
  if (
    /\b(?:website|web site|webpage|web page|homepage|home page)\b/.test(
      lower,
    ) &&
    showsContent
  ) {
    return true;
  }
  if (/\bhomepage of\b/.test(lower) && showsContent) {
    return true;
  }
  return aboutAPage && /\bis open\b/.test(lower);
}

function isAssistantMeta(text: string): boolean {
  if (!/^(?:the |this )?(?:assistant|language model|model|ai)\b/i.test(text)) {
    return false;
  }
  return /\b(?:said|says|responded|replied|told|explained|answered|fetched|fetch|did|didn't|did not|acknowledged|confirmed|noted|unable)\b/i.test(
    text,
  );
}
