// Pure resize math for the right sidebar.
//
// No rounding here — the persisted setter (`setRightSidebarWidth` in
// `right-sidebar-prefs.ts`) rounds + clamps on write.
// `deltaSign = -1` is the right-sidebar convention (drag left ⇒ grow).
// Clean-room behavioral port of Orca's `useSidebarResize` math (behavior and
// token shape only, no code copied).

export function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resizeFromDrag(input: {
  clientX: number;
  startX: number;
  startWidth: number;
  deltaSign: number;
  minWidth: number;
  maxWidth: number;
}): number {
  return clampWidth(
    input.startWidth + (input.clientX - input.startX) * input.deltaSign,
    input.minWidth,
    input.maxWidth,
  );
}
