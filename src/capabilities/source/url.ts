import { isIP } from "node:net";
import { CapabilityValidationError } from "../wire/primitives.js";

function canonicalUrl(value: string, allowed: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CapabilityValidationError("invalid absolute URL", "url");
  }
  if (!allowed.includes(url.protocol))
    throw new CapabilityValidationError("URL protocol is not allowed", "url");
  if (url.username || url.password)
    throw new CapabilityValidationError("credentials in URLs are forbidden", "url");
  if (url.hostname !== url.hostname.toLowerCase() || url.hostname.endsWith("."))
    throw new CapabilityValidationError("URL host is not canonical lowercase IDNA", "url");
  if (url.hash) throw new CapabilityValidationError("URL fragments are forbidden", "url");
  return url;
}

export function assertCanonicalRegistryOrigin(value: string): string {
  const url = canonicalUrl(value, ["https:"]);
  if (url.pathname !== "/" || url.search || url.port === "443")
    throw new CapabilityValidationError(
      "registry origin cannot contain path/query/default port",
      "registry_origin",
    );
  const canonical = url.origin;
  if (canonical !== value)
    throw new CapabilityValidationError("registry origin is not canonical", "registry_origin");
  return canonical;
}

export function assertCanonicalHttpsUrl(value: string, sameOrigin?: string): string {
  const url = canonicalUrl(value, ["https:"]);
  if (url.port === "443")
    throw new CapabilityValidationError("explicit default HTTPS port is non-canonical", "url");
  const canonical = url.toString();
  if (canonical !== value) throw new CapabilityValidationError("HTTPS URL is not canonical", "url");
  if (sameOrigin !== undefined && url.origin !== assertCanonicalRegistryOrigin(sameOrigin))
    throw new CapabilityValidationError("URL leaves the configured registry origin", "url");
  return canonical;
}

export function assertCanonicalSourceUrl(value: string): string {
  return assertCanonicalHttpsUrl(value);
}

export function registryIndexUrl(origin: string): string {
  return `${assertCanonicalRegistryOrigin(origin)}/v1/capabilities/index.json`;
}

function ipv4Private(value: string): boolean {
  const parts = value.split(".").map(Number);
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && (b ?? 0) >= 16 && (b ?? 0) <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && (b ?? 0) >= 64 && (b ?? 0) <= 127) ||
    (a ?? 0) >= 224
  );
}

function ipv6Private(value: string): boolean {
  const host = value.toLowerCase();
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    /^fe[89ab]/.test(host) ||
    host.startsWith("ff")
  );
}

export function assertPublicNetworkAddresses(
  addresses: readonly string[],
  allowLocalDev = false,
): void {
  if (addresses.length === 0)
    throw new CapabilityValidationError("DNS resolution returned no addresses", "addresses");
  if (allowLocalDev) return;
  for (const address of addresses) {
    const family = isIP(address);
    if (!family || (family === 4 ? ipv4Private(address) : ipv6Private(address)))
      throw new CapabilityValidationError(
        "private, local, or invalid network address rejected",
        "addresses",
      );
  }
}

export interface RedirectPolicyV1 {
  initial_url: string;
  redirects: string[];
  resolved_addresses: ReadonlyMap<string, readonly string[]>;
  max_redirects?: number;
  allow_local_dev?: boolean;
}

export function validateRedirectChain(policy: RedirectPolicyV1): string {
  const limit = policy.max_redirects ?? 5;
  if (policy.redirects.length > limit)
    throw new CapabilityValidationError("redirect limit exceeded", "redirects");
  let current = assertCanonicalHttpsUrl(policy.initial_url);
  for (const candidate of [current, ...policy.redirects]) {
    current = assertCanonicalHttpsUrl(candidate);
    const host = new URL(current).hostname;
    assertPublicNetworkAddresses(policy.resolved_addresses.get(host) ?? [], policy.allow_local_dev);
  }
  return current;
}
