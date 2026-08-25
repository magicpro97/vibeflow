import { durabilityError } from "./errors.js";

export function positiveSafeLimit(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    durabilityError("bounds", `${label} must be a positive safe integer`);
  return value as number;
}

export function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    durabilityError("bounds", `${label} must be a non-negative safe integer`);
  return value as number;
}
