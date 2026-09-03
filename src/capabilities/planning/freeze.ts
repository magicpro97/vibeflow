export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): Readonly<T> {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, item] of value) {
      deepFreeze(key, seen);
      deepFreeze(item, seen);
    }
  } else if (value instanceof Set) {
    for (const item of value) deepFreeze(item, seen);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item, seen);
  }
  return Object.freeze(value);
}

export function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value)) as T;
}
