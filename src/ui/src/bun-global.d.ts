// The ui typecheck loads root modules it imports for types (src/resources.ts
// → src/core.ts → src/core/command-runtime.ts, which calls `Bun.which`).
// ui tsconfig sets "types": [] on purpose — pulling in @types/bun would swap
// the DOM `fetch` for Bun's (preconnect) and break existing fetch casts — so
// declare only the slice of the Bun global that chain uses.
declare const Bun: {
  which(command: string, options?: { cwd?: string; PATH?: string }): string | null;
};
