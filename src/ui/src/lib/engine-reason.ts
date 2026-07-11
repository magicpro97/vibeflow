// #458: actionable per-engine reason from preflight readiness level.
// ponytail: 5-level map. Upgrade to show `detail` verbatim if levels grow.
export function engineReason(level: string | undefined): string {
  switch (level) {
    case "no-binary":
      return "not installed";
    case "no-auth":
      return "not authenticated";
    case "probe-failed":
      return "installed but not responding";
    case "unknown":
      return "status unknown";
    default:
      return "unavailable"; // ready never shows a reason; missing -> generic
  }
}
