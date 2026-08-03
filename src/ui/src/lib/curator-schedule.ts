/** #689: shared UI cron validator mirror — must match backend isValidCuratorCron semantics. */

export function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 31 || c === 127) return true;
  }
  return false;
}

function isDigits(s: string): boolean {
  return /^\d+$/.test(s);
}

function isValidField(field: string, [min, max]: [number, number]): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part === "") return false;
    let base = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      base = part.slice(0, slash);
      const stepStr = part.slice(slash + 1);
      if (stepStr === "" || !isDigits(stepStr)) return false;
      step = Number(stepStr);
      if (!Number.isSafeInteger(step) || step < 1 || step > max) return false;
    }
    let lo = min;
    let hi = max;
    if (base !== "*") {
      const dash = base.indexOf("-");
      if (dash !== -1) {
        const a = base.slice(0, dash);
        const b = base.slice(dash + 1);
        if (!isDigits(a) || !isDigits(b)) return false;
        lo = Number(a);
        hi = Number(b);
      } else {
        if (!isDigits(base)) return false;
        lo = Number(base);
        hi = lo;
      }
      if (lo < min || hi > max || lo > hi) return false;
    }
  }
  return true;
}

export function isValidSchedule(s: string): boolean {
  if (typeof s !== "string" || s.length > 100 || hasControlChar(s)) return false;
  const parts = s.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    const range = ranges[i];
    if (field === undefined || range === undefined) return false;
    if (!isValidField(field, range)) return false;
  }
  return true;
}
