/** #561: warn when the UI is bound to all interfaces (LAN-exposed). Returns the
 *  warning string for host 0.0.0.0, else null. Pure — isolated for unit testing
 *  without pulling the cli.ts entry point into the coverage report. */
export function lanExposureWarning(host: string | undefined): string | null {
  return host === "0.0.0.0"
    ? "WARNING: server exposed to LAN — anyone on the network can access; token required in URL"
    : null;
}
