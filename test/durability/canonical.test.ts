import { expect, test } from "bun:test";
import {
  canonicalJson,
  canonicalJsonBytes,
  digestHex,
  digestV1,
  sha256Digest,
} from "../../src/durability/index.js";

test("canonical JSON matches RFC 8785 number, escaping, and UTF-16 key ordering vectors", () => {
  expect(
    canonicalJson({
      string: '€$\u000f\nA\'B"\\\\"/',
      numbers: [Number("333333333.33333329"), 1e30, 4.5, 0.002, 1e-27, -0],
      literals: [null, true, false],
    }),
  ).toBe(
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  );

  expect(
    canonicalJson({
      דּ: 7,
      "€": 5,
      "\r": 1,
      "😀": 6,
      "1": 2,
      ö: 4,
      "\u0080": 3,
    }),
  ).toBe('{"\\r":1,"1":2,"":3,"ö":4,"€":5,"😀":6,"דּ":7}');
});

test("canonical JSON is byte-stable without mutating or normalizing schema-owned text", () => {
  const value = { z: ["e\u0301", { b: 2, a: 1 }], a: "é" };
  const before = JSON.stringify(value);
  expect(canonicalJsonBytes(value)).toEqual(
    Buffer.from('{"a":"é","z":["é",{"a":1,"b":2}]}', "utf8"),
  );
  expect(JSON.stringify(value)).toBe(before);
});

test("canonical JSON rejects non-JSON, unsafe object shapes, invalid Unicode, and polluted prototypes", () => {
  const sparse = Array(2);
  sparse[1] = 2;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
  const nonEnumerable = { ok: 1 };
  Object.defineProperty(nonEnumerable, "hidden", { value: 2 });

  for (const value of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    Symbol("x"),
    () => null,
    new Date(0),
    sparse,
    cyclic,
    accessor,
    nonEnumerable,
    { __proto__: { polluted: true } },
    "\ud800",
  ]) {
    expect(() => canonicalJson(value)).toThrow();
  }
  expect(canonicalJson(JSON.parse('{"__proto__":1,"constructor":2,"prototype":3}'))).toBe(
    '{"__proto__":1,"constructor":2,"prototype":3}',
  );
});

test("digestV1 is domain-separated, length-prefixed, and has stable golden vectors", () => {
  const value = { schema_version: "1.0", a: 1, nested: [true, null, "é"] };
  expect(digestV1("VF-TEST\0v1\0", value)).toBe(
    "sha256:211589008ad2b981e1f8f67924a67271efe1b559672359d4d41d3fbc2c4f91d3",
  );
  expect(digestHex(digestV1("VF-TEST\0v1\0", value))).toBe(
    "211589008ad2b981e1f8f67924a67271efe1b559672359d4d41d3fbc2c4f91d3",
  );
  expect(digestV1("VF-OTHER\0v1\0", value)).not.toBe(digestV1("VF-TEST\0v1\0", value));
  expect(digestV1("VF-TEST\0v1\0", { ...value, a: 2 })).not.toBe(digestV1("VF-TEST\0v1\0", value));
  expect(() => digestV1("VF-TEST", value)).toThrow();
  expect(sha256Digest(Buffer.from("abc"))).toBe(
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("digestHex accepts only the normative lowercase sha256 encoding", () => {
  expect(() => digestHex("ce4612")).toThrow();
  expect(() => digestHex(`sha256:${"A".repeat(64)}`)).toThrow();
  expect(() => digestHex(`sha512:${"a".repeat(64)}`)).toThrow();
});

test("canonical JSON rejects invalid caps before work and stops incrementally at the byte bound", () => {
  for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
    expect(() => canonicalJson({ ok: true }, { maxBytes })).toThrow(/bound|limit/i);
  }
  for (const maxNodes of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
    expect(() => canonicalJson({ ok: true }, { maxNodes })).toThrow(/bound|limit/i);
  }
  for (const maxDepth of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
    expect(() => canonicalJson({ ok: true }, { maxDepth })).toThrow(/bound|limit/i);
  }

  const cyclic: unknown[] = ["x".repeat(4_096)];
  cyclic.push(cyclic);
  expect(() => canonicalJson(cyclic, { maxBytes: 32 })).toThrow(/byte limit/i);
});
