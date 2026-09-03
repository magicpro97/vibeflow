import { createHash, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { type JsonValue, canonicalJsonBytes } from "./canonical.js";
import { withCleanup } from "./cleanup.js";
import { durabilityError } from "./errors.js";
import {
  type DecodedVffrFrame,
  VFFR_DOMAINS,
  type VffrAppendOptions,
  type VffrDomain,
  VffrError,
  type VffrFailureKind,
  type VffrReadOptions,
} from "./frame-contract.js";
import {
  assertVisibleVffrEntry,
  openVffrFileForAppendAt,
  publishFirstVffrFrameAt,
  vffrFileBytes,
} from "./frame-file.js";
import { type VffrDomainRule, vffrRuleFor } from "./frame-rules.js";
import { nonNegativeSafeInteger, positiveSafeLimit } from "./limits.js";
import { assertProcessLockCovers, withLockedParent } from "./lock.js";
import { assertPinnedDirectory, canonicalDurabilityPath } from "./native.js";
import { readPrivateFd, writeAll } from "./path.js";

const MAGIC = Buffer.from("VFFR", "ascii");
const CHECKSUM_DOMAIN = Buffer.from("VF-FRAME-CHECKSUM\0v1\0", "utf8");
const HEADER_BYTES = 20;
const CHECKSUM_BYTES = 32;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DOMAIN_SET = new Set<string>(VFFR_DOMAINS);

interface VffrCodecSnapshot {
  readonly domain: VffrDomain;
  readonly rule: VffrDomainRule;
  readonly maxFrames: number;
  readonly maxPayloadBytes: number;
  readonly maxAggregateBytes: number;
  readonly sequenceStart: number;
  readonly initialPreviousDigest: string | null;
  readonly validatePayload: VffrReadOptions["validatePayload"];
  readonly computePayloadDigest: VffrReadOptions["computePayloadDigest"];
  readonly validateJournalIdentity: VffrReadOptions["validateJournalIdentity"];
}

function snapshotOptions(options: VffrReadOptions): VffrCodecSnapshot {
  if (!options || typeof options !== "object")
    durabilityError("invalid_value", "VFFR codec options are required");
  const domain = options.domain;
  const maxFrames = options.maxFrames;
  const maxPayloadBytes = options.maxPayloadBytes;
  const maxAggregateBytes = options.maxAggregateBytes;
  const sequenceStart = options.sequenceStart ?? 0;
  const initialPreviousDigest = options.initialPreviousDigest ?? null;
  const validatePayload = options.validatePayload;
  const computePayloadDigest = options.computePayloadDigest;
  const validateJournalIdentity = options.validateJournalIdentity;
  positiveSafeLimit(maxFrames, "VFFR frame count limit");
  positiveSafeLimit(maxPayloadBytes, "VFFR payload byte limit");
  positiveSafeLimit(maxAggregateBytes, "VFFR aggregate byte limit");
  nonNegativeSafeInteger(sequenceStart, "VFFR starting sequence");
  if (
    initialPreviousDigest !== null &&
    (typeof initialPreviousDigest !== "string" || !DIGEST_PATTERN.test(initialPreviousDigest))
  )
    durabilityError("invalid_value", "VFFR initial previous digest is invalid");
  for (const [label, callback] of [
    ["validatePayload", validatePayload],
    ["computePayloadDigest", computePayloadDigest],
    ["validateJournalIdentity", validateJournalIdentity],
  ] as const) {
    if (typeof callback !== "function")
      durabilityError("invalid_value", `VFFR codec callback ${label} is required`);
  }
  const rule = DOMAIN_SET.has(domain) ? vffrRuleFor(domain) : undefined;
  if (!rule) durabilityError("invalid_value", "unknown VFFR codec domain");
  return Object.freeze({
    domain,
    rule,
    maxFrames,
    maxPayloadBytes,
    maxAggregateBytes,
    sequenceStart,
    initialPreviousDigest,
    validatePayload,
    computePayloadDigest,
    validateJournalIdentity,
  });
}

function fail(kind: VffrFailureKind, message: string, offset: number, cause?: unknown): never {
  throw new VffrError(kind, message, offset, cause === undefined ? undefined : { cause });
}

function payloadRecord(value: unknown, offset: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("corrupt", "VFFR payload must be an object", offset);
  return value as Record<string, unknown>;
}

function selectedTimestamp(
  payload: Record<string, unknown>,
  rule: VffrDomainRule,
  offset: number,
): string {
  const value = rule.timestamp.map((key) => payload[key]).find((candidate) => candidate != null);
  if (
    typeof value !== "string" ||
    !TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("corrupt", "VFFR payload selected timestamp is invalid", offset);
  return value;
}

function sequenceFrom(
  payload: Record<string, unknown>,
  rule: VffrDomainRule,
  offset: number,
): number {
  const sequence = payload[rule.sequence];
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 0)
    fail("corrupt", "VFFR payload sequence is invalid", offset);
  return sequence as number;
}

function selfDigestFrom(
  payload: Record<string, unknown>,
  rule: VffrDomainRule,
  offset: number,
): string {
  const digest = payload[rule.selfDigest];
  if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest))
    fail("corrupt", "VFFR payload self digest is invalid", offset);
  return digest;
}

function buildHeader(domainLength: number, sequence: number, payloadLength: number): Buffer {
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    durabilityError("invalid_value", "VFFR sequence must be a safe unsigned integer");
  if (domainLength > 0xffff || payloadLength > 0xffff_ffff)
    durabilityError("bounds", "VFFR domain or payload exceeds framing limits");
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header[4] = 1;
  header[5] = 0;
  header.writeUInt16BE(domainLength, 6);
  header.writeBigUInt64BE(BigInt(sequence), 8);
  header.writeUInt32BE(payloadLength, 16);
  return header;
}

function encodeVffrFrameInternal(
  domain: VffrDomain,
  payload: JsonValue,
  codec: VffrCodecSnapshot,
  enforceInitialContext: boolean,
): Buffer {
  if (!DOMAIN_SET.has(domain)) durabilityError("invalid_value", "unknown VFFR domain");
  if (domain !== codec.domain) durabilityError("invalid_value", "VFFR codec domain mismatch");
  const payloadBytes = canonicalJsonBytes(payload, { maxBytes: codec.maxPayloadBytes });
  const record = payloadRecord(JSON.parse(payloadBytes.toString("utf8")), 0);
  if (record.schema_version !== "1.0")
    durabilityError("invalid_value", "VFFR payload schema_version must be 1.0");
  const rule = codec.rule;
  const sequence = sequenceFrom(record, rule, 0);
  if (enforceInitialContext && sequence !== codec.sequenceStart)
    durabilityError("invalid_value", "VFFR payload does not match the starting sequence");
  if (enforceInitialContext && record[rule.previousDigest] !== codec.initialPreviousDigest)
    durabilityError("invalid_value", "VFFR payload does not match the initial previous digest");
  const observedDigest = selfDigestFrom(record, rule, 0);
  selectedTimestamp(record, rule, 0);
  let computedDigest: string;
  let identityMatches: boolean;
  try {
    const copy = () => payloadRecord(JSON.parse(payloadBytes.toString("utf8")), 0);
    codec.validatePayload(copy(), sequence);
    identityMatches = codec.validateJournalIdentity(copy(), sequence);
    computedDigest = codec.computePayloadDigest(copy(), sequence);
  } catch (error) {
    durabilityError("invalid_value", "VFFR codec callback rejected the payload", error);
  }
  if (identityMatches !== true)
    durabilityError("invalid_value", "VFFR payload journal identity mismatch");
  if (!DIGEST_PATTERN.test(computedDigest) || observedDigest !== computedDigest)
    durabilityError("invalid_value", "VFFR payload self digest mismatch");
  const domainBytes = Buffer.from(domain, "ascii");
  const header = buildHeader(domainBytes.length, sequence, payloadBytes.length);
  const checksum = createHash("sha256")
    .update(CHECKSUM_DOMAIN)
    .update(header)
    .update(domainBytes)
    .update(payloadBytes)
    .digest();
  const encoded = Buffer.concat([header, domainBytes, payloadBytes, checksum]);
  if (encoded.length > codec.maxAggregateBytes)
    durabilityError("bounds", "VFFR aggregate byte limit exceeded");
  return encoded;
}

export function encodeVffrFrame(
  domain: VffrDomain,
  payload: JsonValue,
  options: VffrReadOptions,
): Buffer {
  return encodeVffrFrameInternal(domain, payload, snapshotOptions(options), true);
}

function readVffrSnapshot(input: Buffer, codec: VffrCodecSnapshot): DecodedVffrFrame[] {
  const { maxFrames, maxPayloadBytes, maxAggregateBytes, sequenceStart } = codec;
  if (input.length > maxAggregateBytes) fail("bounds", "VFFR aggregate byte limit exceeded", 0);
  if (input.length === 0) fail("corrupt", "VFFR journal is empty", 0);
  const decoded: DecodedVffrFrame[] = [];
  let offset = 0;
  let previous = codec.initialPreviousDigest;
  while (offset < input.length) {
    if (decoded.length >= maxFrames) fail("bounds", "VFFR frame count limit exceeded", offset);
    if (input.length - offset < HEADER_BYTES) fail("corrupt", "VFFR truncated header", offset);
    const header = input.subarray(offset, offset + HEADER_BYTES);
    if (!header.subarray(0, 4).equals(MAGIC)) fail("corrupt", "VFFR magic mismatch", offset);
    if (header[4] !== 1) fail("corrupt", "VFFR unknown major version", offset);
    if (header[5] !== 0) fail("corrupt", "VFFR reserved byte is non-zero", offset);
    const domainLength = header.readUInt16BE(6);
    const sequenceBig = header.readBigUInt64BE(8);
    if (sequenceBig > BigInt(Number.MAX_SAFE_INTEGER))
      fail("bounds", "VFFR sequence overflow", offset);
    const headerSequence = Number(sequenceBig);
    const payloadLength = header.readUInt32BE(16);
    if (payloadLength > maxPayloadBytes) fail("bounds", "VFFR payload byte limit exceeded", offset);
    const frameLength = HEADER_BYTES + domainLength + payloadLength + CHECKSUM_BYTES;
    if (frameLength > input.length - offset) fail("corrupt", "VFFR truncated frame", offset);
    const domainStart = offset + HEADER_BYTES;
    const payloadStart = domainStart + domainLength;
    const checksumStart = payloadStart + payloadLength;
    const domainBytes = input.subarray(domainStart, payloadStart);
    if ([...domainBytes].some((byte) => byte < 0x20 || byte > 0x7e))
      fail("corrupt", "VFFR domain is not printable ASCII", offset);
    const domain = domainBytes.toString("ascii");
    if (!DOMAIN_SET.has(domain)) fail("corrupt", "VFFR unknown domain", offset);
    if (domain !== codec.domain) fail("corrupt", "VFFR copied to wrong journal domain", offset);
    const payloadBytes = input.subarray(payloadStart, checksumStart);
    const observedChecksum = input.subarray(checksumStart, checksumStart + CHECKSUM_BYTES);
    const expectedChecksum = createHash("sha256")
      .update(CHECKSUM_DOMAIN)
      .update(header)
      .update(domainBytes)
      .update(payloadBytes)
      .digest();
    if (!timingSafeEqual(observedChecksum, expectedChecksum))
      fail("corrupt", "VFFR checksum mismatch", offset);
    let payload: Record<string, unknown>;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
      payload = payloadRecord(JSON.parse(text), offset);
      const canonical = canonicalJsonBytes(payload, { maxBytes: maxPayloadBytes });
      if (canonical.length !== payloadBytes.length || !timingSafeEqual(canonical, payloadBytes))
        fail("corrupt", "VFFR payload is not canonical JSON", offset);
    } catch (error) {
      if (error instanceof VffrError) throw error;
      fail("corrupt", "VFFR payload JSON is invalid", offset, error);
    }
    if (payload.schema_version !== "1.0")
      fail("unsupported", "VFFR payload schema major is unsupported", offset);
    const rule = codec.rule;
    const payloadSequence = sequenceFrom(payload, rule, offset);
    const expectedSequence = sequenceStart + decoded.length;
    if (headerSequence !== payloadSequence || payloadSequence !== expectedSequence)
      fail("corrupt", "VFFR sequence is not dense or does not match payload", offset);
    const prior = payload[rule.previousDigest];
    if (prior !== previous) fail("corrupt", "VFFR previous digest chain mismatch", offset);
    const selfDigest = selfDigestFrom(payload, rule, offset);
    try {
      const copy = () => payloadRecord(JSON.parse(payloadBytes.toString("utf8")), offset);
      const computedDigest = codec.computePayloadDigest(copy(), payloadSequence);
      if (!DIGEST_PATTERN.test(computedDigest) || computedDigest !== selfDigest)
        fail("corrupt", "VFFR payload self digest verification failed", offset);
      if (codec.validateJournalIdentity(copy(), payloadSequence) !== true)
        fail("corrupt", "VFFR copied to wrong journal identity", offset);
      codec.validatePayload(copy(), payloadSequence);
    } catch (error) {
      if (error instanceof VffrError) throw error;
      fail("corrupt", "VFFR payload schema validation failed", offset, error);
    }
    decoded.push({
      domain: codec.domain,
      sequence: payloadSequence,
      payload,
      payloadBytes: Buffer.from(payloadBytes),
      checksum: `sha256:${observedChecksum.toString("hex")}`,
      offset,
      byteLength: frameLength,
      selfDigest,
      selectedTimestamp: selectedTimestamp(payload, rule, offset),
    });
    previous = selfDigest;
    offset += frameLength;
  }
  return decoded;
}

export function readVffrBytes(bytes: Uint8Array, options: VffrReadOptions): DecodedVffrFrame[] {
  const input = Buffer.from(bytes);
  return readVffrSnapshot(input, snapshotOptions(options));
}

export function readVffrFile(path: string, options: VffrReadOptions): DecodedVffrFrame[] {
  const codec = snapshotOptions(options);
  const target = canonicalDurabilityPath(path);
  const bytes = vffrFileBytes(target, codec.maxAggregateBytes);
  if (bytes === null) durabilityError("corrupt", `VFFR journal is missing: ${target}`);
  return readVffrSnapshot(Buffer.from(bytes), codec);
}

export function appendVffrFrame(
  path: string,
  domain: VffrDomain,
  payload: JsonValue,
  options: VffrAppendOptions,
): DecodedVffrFrame {
  const target = canonicalDurabilityPath(path);
  const lock = options.lock;
  const fault = options.fault;
  const codec = snapshotOptions(options);
  if (domain !== codec.domain) durabilityError("invalid_value", "VFFR append domain mismatch");
  const encoded = encodeVffrFrameInternal(domain, payload, codec, false);
  assertProcessLockCovers(lock, target);
  if (lock.path === target)
    durabilityError("lock_lost", "VFFR journal cannot be its owning process lock");
  const before = vffrFileBytes(target, codec.maxAggregateBytes);
  const firstDecoded =
    before === null ? (readVffrSnapshot(Buffer.from(encoded), codec)[0] as DecodedVffrFrame) : null;
  return withLockedParent(lock, target, before === null, (directory, name) => {
    const existing = openVffrFileForAppendAt(directory, name);
    if (existing === null) {
      if (firstDecoded === null)
        durabilityError("conflict", "VFFR journal disappeared during append");
      publishFirstVffrFrameAt(directory, name, encoded, fault);
      return firstDecoded;
    }
    const fd = existing;
    return withCleanup(() => {
      const current = readPrivateFd(fd, name, codec.maxAggregateBytes);
      readVffrSnapshot(Buffer.from(current), codec);
      if (current.length + encoded.length > codec.maxAggregateBytes)
        durabilityError("bounds", "VFFR aggregate byte limit exceeded");
      const candidate = Buffer.concat([current, encoded]);
      const decoded = readVffrSnapshot(candidate, codec);
      assertPinnedDirectory(directory);
      lock.assertHeld();
      fault?.("before-existing-frame-write");
      assertVisibleVffrEntry(directory, name, fd);
      writeAll(fd, encoded, current.length);
      fs.fsyncSync(fd);
      fault?.("after-existing-frame-fsync");
      assertVisibleVffrEntry(directory, name, fd);
      assertPinnedDirectory(directory);
      fs.fsyncSync(directory.fd);
      assertVisibleVffrEntry(directory, name, fd);
      return decoded[decoded.length - 1] as DecodedVffrFrame;
    }, [() => fs.closeSync(fd)]);
  });
}
