const PALETTE = [
  "text-sky-400 bg-sky-500/10",
  "text-emerald-400 bg-emerald-500/10",
  "text-amber-400 bg-amber-500/10",
  "text-violet-400 bg-violet-500/10",
  "text-rose-400 bg-rose-500/10",
  "text-cyan-400 bg-cyan-500/10",
] as const;

export function unitColor(unit?: string): string {
  if (!unit) return "text-neutral-600 bg-neutral-800/60";
  let h = 5381;
  for (let i = 0; i < unit.length; i++) h = ((h << 5) + h + unit.charCodeAt(i)) >>> 0;
  // modulo keeps the index in [0, PALETTE.length) — always defined.
  return PALETTE[h % PALETTE.length] as string;
}
