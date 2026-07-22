import type { ScanStatus } from "../types.js";

export interface ScanDisplay {
  label: string;
  color: string;
  dot: string;
}

export function scanDisplay(status: ScanStatus): ScanDisplay {
  switch (status) {
    case "pass":
      return { label: "Pass", color: "text-green-400", dot: "bg-green-400" };
    case "warn":
      return { label: "Warn", color: "text-yellow-400", dot: "bg-yellow-400" };
    case "blocked":
      return { label: "Blocked", color: "text-red-400", dot: "bg-red-400" };
    case "not-scanned":
      return { label: "Not scanned", color: "text-neutral-500", dot: "bg-neutral-600" };
  }
}
