import { createHash, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { durabilityError } from "./errors.js";
import { readPrivateFd, writeAll } from "./path.js";

export type LockSlotFaultPoint = "mid-write" | "written" | "fsynced";

export interface StableLockRecord {
  generation: number;
  payload: Buffer | null;
  slot: 0 | 1 | null;
}

const MAGIC = Buffer.from("VFLS", "ascii");
const CHECKSUM_DOMAIN = Buffer.from("VF-LOCK-OWNER-SLOT\0v1\0", "utf8");
const SLOT_BYTES = 4_096;
const FILE_BYTES = SLOT_BYTES * 2;
const HEADER_BYTES = 20;
const CHECKSUM_BYTES = 32;
const BODY_BYTES = SLOT_BYTES - CHECKSUM_BYTES;
const MAX_PAYLOAD_BYTES = BODY_BYTES - HEADER_BYTES;

function checksum(body: Uint8Array): Buffer {
  return createHash("sha256").update(CHECKSUM_DOMAIN).update(body).digest();
}

function encodeSlot(generation: number, payload: Uint8Array | null): Buffer {
  if (!Number.isSafeInteger(generation) || generation < 0)
    durabilityError("bounds", "process lock generation is invalid or exhausted");
  if (payload && payload.length > MAX_PAYLOAD_BYTES)
    durabilityError("bounds", "process lock owner metadata exceeds slot limit");
  const slot = Buffer.alloc(SLOT_BYTES);
  MAGIC.copy(slot, 0);
  slot[4] = 1;
  slot[5] = payload === null ? 0 : 1;
  slot.writeBigUInt64BE(BigInt(generation), 8);
  slot.writeUInt32BE(payload?.length ?? 0, 16);
  if (payload) Buffer.from(payload).copy(slot, HEADER_BYTES);
  checksum(slot.subarray(0, BODY_BYTES)).copy(slot, BODY_BYTES);
  return slot;
}

const INITIAL_SLOT = encodeSlot(0, null);

function parseSlot(bytes: Buffer, slot: 0 | 1): StableLockRecord | null {
  if (bytes.every((byte) => byte === 0)) return null;
  const body = bytes.subarray(0, BODY_BYTES);
  if (!timingSafeEqual(checksum(body), bytes.subarray(BODY_BYTES))) return null;
  if (!bytes.subarray(0, 4).equals(MAGIC) || bytes[4] !== 1 || bytes[6] !== 0 || bytes[7] !== 0)
    durabilityError("corrupt", "invalid process lock slot header");
  const state = bytes[5];
  if (state !== 0 && state !== 1) durabilityError("corrupt", "invalid process lock slot state");
  const generationBig = bytes.readBigUInt64BE(8);
  if (generationBig > BigInt(Number.MAX_SAFE_INTEGER))
    durabilityError("bounds", "process lock generation exceeds the safe bound");
  const payloadLength = bytes.readUInt32BE(16);
  if (
    payloadLength > MAX_PAYLOAD_BYTES ||
    (state === 0 && payloadLength !== 0) ||
    (state === 1 && payloadLength === 0)
  )
    durabilityError("corrupt", "invalid process lock slot payload length");
  const padding = bytes.subarray(HEADER_BYTES + payloadLength, BODY_BYTES);
  if (padding.some((byte) => byte !== 0))
    durabilityError("corrupt", "process lock slot padding is non-zero");
  return {
    generation: Number(generationBig),
    payload:
      state === 0 ? null : Buffer.from(bytes.subarray(HEADER_BYTES, HEADER_BYTES + payloadLength)),
    slot,
  };
}

function recoverableInitialPrefix(bytes: Buffer): boolean {
  if (bytes.length === 0 || bytes.every((byte) => byte === 0)) return true;
  const first = bytes.subarray(0, SLOT_BYTES);
  let prefix = 0;
  while (prefix < first.length && first[prefix] === INITIAL_SLOT[prefix]) prefix++;
  return (
    first.subarray(prefix).every((byte) => byte === 0) &&
    bytes.subarray(SLOT_BYTES).every((byte) => byte === 0)
  );
}

export function readStableLockRecord(fd: number, label: string): StableLockRecord {
  const bytes = readPrivateFd(fd, label, FILE_BYTES);
  if (bytes.length === 0) return { generation: 0, payload: null, slot: null };
  if (bytes.length !== FILE_BYTES)
    durabilityError("corrupt", "process lock slot file has an invalid size");
  const candidates = ([0, 1] as const)
    .map((slot) => parseSlot(bytes.subarray(slot * SLOT_BYTES, (slot + 1) * SLOT_BYTES), slot))
    .filter((record): record is StableLockRecord => record !== null)
    .sort((left, right) => right.generation - left.generation);
  if (candidates.length === 0) {
    if (recoverableInitialPrefix(bytes)) return { generation: 0, payload: null, slot: null };
    durabilityError("corrupt", "process lock has no valid owner slot");
  }
  for (const candidate of candidates) {
    if (candidate.generation % 2 !== candidate.slot)
      durabilityError("corrupt", "process lock slot generation parity violates topology");
    if (candidate.generation === 0 && (candidate.slot !== 0 || candidate.payload !== null))
      durabilityError("corrupt", "process lock initial slot violates topology");
  }
  if (candidates.length === 2 && candidates[0]?.generation === candidates[1]?.generation)
    durabilityError("corrupt", "process lock slots reuse a generation");
  if (
    candidates.length === 2 &&
    (candidates[0] as StableLockRecord).generation -
      (candidates[1] as StableLockRecord).generation !==
      1
  )
    durabilityError("corrupt", "process lock slot generations are not adjacent in topology");
  return candidates[0] as StableLockRecord;
}

export function ensureStableLockInitialized(fd: number, label: string): StableLockRecord {
  const record = readStableLockRecord(fd, label);
  const stat = fs.fstatSync(fd);
  if (stat.size === FILE_BYTES && record.slot !== null) return record;
  fs.ftruncateSync(fd, FILE_BYTES);
  writeAll(fd, INITIAL_SLOT, 0);
  fs.fsyncSync(fd);
  return readStableLockRecord(fd, label);
}

export function publishStableLockRecord(
  fd: number,
  label: string,
  previous: StableLockRecord,
  payload: Uint8Array | null,
  fault?: (point: LockSlotFaultPoint) => void,
): StableLockRecord {
  if (previous.generation >= Number.MAX_SAFE_INTEGER)
    durabilityError("bounds", "process lock generation is exhausted");
  const generation = previous.generation + 1;
  const slotIndex: 0 | 1 = previous.slot === 0 ? 1 : 0;
  const encoded = encodeSlot(generation, payload);
  const base = slotIndex * SLOT_BYTES;
  writeAll(fd, Buffer.alloc(CHECKSUM_BYTES), base + BODY_BYTES);
  const midpoint = Math.floor(BODY_BYTES / 2);
  writeAll(fd, encoded.subarray(0, midpoint), base);
  fault?.("mid-write");
  writeAll(fd, encoded.subarray(midpoint, BODY_BYTES), base + midpoint);
  writeAll(fd, encoded.subarray(BODY_BYTES), base + BODY_BYTES);
  fault?.("written");
  fs.fsyncSync(fd);
  fault?.("fsynced");
  const committed = readStableLockRecord(fd, label);
  if (committed.generation !== generation || committed.slot !== slotIndex)
    durabilityError("corrupt", "process lock slot publication did not commit exactly");
  return committed;
}

export const STABLE_LOCK_FILE_BYTES = FILE_BYTES;
