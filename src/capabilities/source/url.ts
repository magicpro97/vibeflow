import { isIP } from "node:net";
import { TLSSocket, checkServerIdentity } from "node:tls";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  exactKeys,
} from "../wire/primitives.js";

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
  const words = ipv6Words(host);
  const embedded =
    words?.slice(0, 5).every((word) => word === 0) && (words[5] === 0xffff || words[5] === 0)
      ? `${(words[6] as number) >>> 8}.${(words[6] as number) & 0xff}.${(words[7] as number) >>> 8}.${(words[7] as number) & 0xff}`
      : null;
  return (
    host === "::" ||
    host === "::1" ||
    (embedded !== null && ipv4Private(embedded)) ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    /^fe[89ab]/.test(host) ||
    host.startsWith("ff")
  );
}

function ipv6Words(value: string): number[] | null {
  let source = value;
  if (source.includes(".")) {
    const split = source.lastIndexOf(":");
    const dotted = source.slice(split + 1);
    if (isIP(dotted) !== 4) return null;
    const octets = dotted.split(".").map(Number);
    source = `${source.slice(0, split)}:${(((octets[0] as number) << 8) | (octets[1] as number)).toString(16)}:${(((octets[2] as number) << 8) | (octets[3] as number)).toString(16)}`;
  }
  if ((source.match(/::/g) ?? []).length > 1) return null;
  const [leftText, rightText] = source.split("::", 2);
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];
  const missing = source.includes("::") ? 8 - left.length - right.length : 0;
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[a-f0-9]{1,4}$/.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

export function assertPublicNetworkAddresses(addresses: readonly string[]): void {
  if (addresses.length === 0 || addresses.length > 64)
    throw new CapabilityValidationError(
      "DNS resolution address count is out of bounds",
      "addresses",
    );
  for (const address of addresses) {
    const family = isIP(address);
    if (!family || (family === 4 ? ipv4Private(address) : ipv6Private(address)))
      throw new CapabilityValidationError(
        "private, local, or invalid network address rejected",
        "addresses",
      );
  }
}

export interface ConnectionAddressBindingV1 {
  requested_url: string;
  hostname: string;
  resolved_addresses: readonly string[];
  connected_address: string;
  connected_port: number;
  peer_certificate_fingerprint256: string;
}

export interface RedirectPolicyV1 {
  initial_url: string;
  hops: readonly ConnectionAddressBindingV1[];
  max_redirects?: number;
}

const CONNECTOR_OWNED_CONNECTIONS = new WeakSet<object>();

export function observeRegistryTlsConnection(input: {
  requested_url: string;
  resolved_addresses: readonly string[];
  socket: TLSSocket;
}): ConnectionAddressBindingV1 {
  const requestedUrl = assertCanonicalHttpsUrl(input.requested_url);
  const url = new URL(requestedUrl);
  if (!(input.socket instanceof TLSSocket) || !input.socket.encrypted || input.socket.destroyed)
    throw new CapabilityValidationError(
      "registry transport did not provide a live TLS connection",
      "connection.socket",
    );
  if (!input.socket.authorized)
    throw new CapabilityValidationError(
      "registry TLS peer is not authorized",
      "connection.socket",
      "integrity_failure",
    );
  const connectedAddress = input.socket.remoteAddress;
  const connectedPort = input.socket.remotePort;
  if (!connectedAddress || connectedPort === undefined)
    throw new CapabilityValidationError(
      "registry TLS connection has no remote endpoint",
      "connection.socket",
    );
  const expectedPort = Number(url.port || "443");
  if (connectedPort !== expectedPort)
    throw new CapabilityValidationError(
      "registry TLS connection port does not match the requested URL",
      "connection.socket",
    );
  if (!Array.isArray(input.resolved_addresses))
    throw new CapabilityValidationError("resolved address set is invalid", "connection.addresses");
  const resolvedAddresses = [...input.resolved_addresses];
  assertSortedUnique(resolvedAddresses, bytewise, "connection.resolved_addresses");
  assertPublicNetworkAddresses(resolvedAddresses);
  assertPublicNetworkAddresses([connectedAddress]);
  if (!resolvedAddresses.includes(connectedAddress))
    throw new CapabilityValidationError(
      "connected address is not in the connector DNS answer",
      "connection.connected_address",
    );
  const certificate = input.socket.getPeerCertificate(true);
  if (!certificate.raw || checkServerIdentity(url.hostname, certificate))
    throw new CapabilityValidationError(
      "registry TLS certificate does not bind the requested hostname",
      "connection.certificate",
      "integrity_failure",
    );
  if (!/^([A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(certificate.fingerprint256))
    throw new CapabilityValidationError(
      "registry TLS certificate fingerprint is unavailable",
      "connection.certificate",
      "integrity_failure",
    );
  const result = Object.freeze({
    requested_url: requestedUrl,
    hostname: url.hostname,
    resolved_addresses: Object.freeze(resolvedAddresses),
    connected_address: connectedAddress,
    connected_port: connectedPort,
    peer_certificate_fingerprint256: certificate.fingerprint256,
  });
  CONNECTOR_OWNED_CONNECTIONS.add(result);
  return result;
}

export function validateRedirectChain(policy: RedirectPolicyV1): string {
  exactKeys(policy, ["initial_url", "hops"], ["max_redirects"], "redirect_policy");
  const limit = policy.max_redirects ?? 5;
  if (!Number.isInteger(limit) || limit < 0 || limit > 20)
    throw new CapabilityValidationError("redirect limit is invalid", "max_redirects");
  if (!Array.isArray(policy.hops) || policy.hops.length === 0)
    throw new CapabilityValidationError("registry connection chain is empty", "hops");
  if (policy.hops.length - 1 > limit)
    throw new CapabilityValidationError("redirect limit exceeded", "redirects");
  const initial = assertCanonicalHttpsUrl(policy.initial_url);
  const origin = new URL(initial).origin;
  const seen = new Set<string>();
  for (const [index, connection] of policy.hops.entries()) {
    if (!CONNECTOR_OWNED_CONNECTIONS.has(connection))
      throw new CapabilityValidationError(
        "registry connection observation is not connector-owned",
        `hops[${index}]`,
        "integrity_failure",
      );
    const current = assertCanonicalHttpsUrl(connection.requested_url);
    if (index === 0 && current !== initial)
      throw new CapabilityValidationError(
        "first connection does not bind the requested registry URL",
        "hops[0]",
      );
    if (new URL(current).origin !== origin)
      throw new CapabilityValidationError("redirect leaves the approved origin", "redirects");
    if (seen.has(current))
      throw new CapabilityValidationError("redirect loop is forbidden", `hops[${index}]`);
    seen.add(current);
  }
  return (policy.hops.at(-1) as ConnectionAddressBindingV1).requested_url;
}
