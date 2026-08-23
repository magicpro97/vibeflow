const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function withoutPort(value: string): string | null {
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return null;
    const suffix = value.slice(close + 1);
    if (suffix && !/^:\d+$/.test(suffix)) return null;
    return value.slice(0, close + 1);
  }
  const first = value.indexOf(":");
  if (first > 0 && first === value.lastIndexOf(":") && /^\d+$/.test(value.slice(first + 1))) {
    return value.slice(0, first);
  }
  return value;
}

/** Shared bind/request-host classifier. Bare IPv6 is never mistaken for host:port. */
export function isConversationLoopbackHost(value: string): boolean {
  const host = withoutPort(value.toLowerCase());
  return host !== null && LOOPBACK_HOSTS.has(host);
}

/** Render a bind hostname as a syntactically valid HTTP authority. */
export function conversationUrlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
