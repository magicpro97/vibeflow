type ValueOf<Contract> = Contract[keyof Contract];

export const CAPABILITY_EXECUTION_LEDGER_MODE = Object.freeze({
  TRANSIENT_PREVIEW: "transient-preview",
  DURABLE_PROPOSAL: "durable-proposal",
} as const);

export type CapabilityExecutionLedgerMode = ValueOf<typeof CAPABILITY_EXECUTION_LEDGER_MODE>;
export const CAPABILITY_EXECUTION_LEDGER_MODES = Object.freeze(
  Object.values(CAPABILITY_EXECUTION_LEDGER_MODE),
);

export const isCapabilityExecutionLedgerMode = (
  value: unknown,
): value is CapabilityExecutionLedgerMode =>
  typeof value === "string" &&
  CAPABILITY_EXECUTION_LEDGER_MODES.some((candidate) => candidate === value);
