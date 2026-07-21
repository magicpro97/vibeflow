export interface BlockAnchor {
  blockId: string;
  quote: string;
  range: { start: number; end: number };
}

export function buildBlockAnchor(
  blockId: string,
  text: string,
  selection?: { start: number; end: number },
): BlockAnchor {
  const range = selection ?? { start: 0, end: text.length };
  const quote = text.slice(range.start, range.end);
  return { blockId, quote, range };
}

export function handleAnchorKeydown(
  e: KeyboardEvent,
  blockId: string,
  text: string,
  emit: (a: BlockAnchor) => void,
) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    emit(buildBlockAnchor(blockId, text));
  }
}
