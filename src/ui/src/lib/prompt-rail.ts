// Prompt navigation rail entries (Orca 1.4.205 "prompt navigation rail" port).
export interface PromptRailEntry {
  id: string;
  anchorKey: string;
  label: string;
  at: string | null;
}

export function promptRailLabel(body: string, max = 48): string {
  const oneLine = body.replace(/\s+/gu, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max).trimEnd()}…` : oneLine;
}

export function buildPromptRail(
  items: readonly {
    kind: string;
    id: string;
    title: string;
    body: string;
    anchorKey: string | null;
    at: string | null;
  }[],
): PromptRailEntry[] {
  const entries: PromptRailEntry[] = [];
  for (const item of items) {
    if (item.kind !== "user" || item.anchorKey === null) continue;
    entries.push({
      id: item.id,
      anchorKey: item.anchorKey,
      label: promptRailLabel(item.body),
      at: item.at,
    });
  }
  return entries;
}
