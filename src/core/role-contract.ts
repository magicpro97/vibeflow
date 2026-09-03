/**
 * Dependency-neutral role protocol shared by role files, renderers, dispatch, and browser DTOs.
 *
 * Runtime objects are the authority. Types, ordered values, subsets, and guards derive from those
 * frozen objects so persisted role files and public projections cannot drift from TypeScript.
 */
type ValueOf<Contract> = Contract[keyof Contract];

const frozenValues = <const Contract extends Readonly<Record<string, string>>>(
  contract: Contract,
) => Object.freeze(Object.values(contract)) as readonly ValueOf<Contract>[];

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const ROLE_TOOL_INTENT = Object.freeze({
  READ: "read",
  WRITE: "write",
  EDIT: "edit",
  BASH: "bash",
  GREP: "grep",
  GLOB: "glob",
  WEB: "web",
} as const);
export type ToolIntent = ValueOf<typeof ROLE_TOOL_INTENT>;
export const ROLE_TOOL_INTENTS = frozenValues(ROLE_TOOL_INTENT);
export const ROLE_MUTATING_TOOL_INTENTS = Object.freeze([
  ROLE_TOOL_INTENT.WRITE,
  ROLE_TOOL_INTENT.EDIT,
  ROLE_TOOL_INTENT.BASH,
] as const);
export type MutatingToolIntent = (typeof ROLE_MUTATING_TOOL_INTENTS)[number];
export const ROLE_READ_ONLY_TOOL_INTENTS = Object.freeze(
  ROLE_TOOL_INTENTS.filter(
    (intent): intent is Exclude<ToolIntent, MutatingToolIntent> =>
      !ROLE_MUTATING_TOOL_INTENTS.some((mutating) => mutating === intent),
  ),
);
export const ROLE_WORKFLOW_TOOL_INTENTS = Object.freeze(
  ROLE_TOOL_INTENTS.filter((intent) => intent !== ROLE_TOOL_INTENT.WEB),
);
export const isRoleToolIntent = (value: unknown): value is ToolIntent =>
  memberOf(ROLE_TOOL_INTENTS, value);
export const isMutatingRoleToolIntent = (value: unknown): value is MutatingToolIntent =>
  memberOf(ROLE_MUTATING_TOOL_INTENTS, value);

export const ROLE_MODEL = Object.freeze({
  HAIKU: "haiku",
  SONNET: "sonnet",
  OPUS: "opus",
  GPT_5_4: "gpt-5.4",
  GPT_5_4_MINI: "gpt-5.4-mini",
  GPT_5_3_CODEX_SPARK: "gpt-5.3-codex-spark",
  GPT_5_4_CODEX: "gpt-5.4-codex",
} as const);
export type RoleModel = ValueOf<typeof ROLE_MODEL>;
export const ROLE_MODELS = frozenValues(ROLE_MODEL);
export const isRoleModel = (value: unknown): value is RoleModel => memberOf(ROLE_MODELS, value);

export const ROLE_SANDBOX = Object.freeze({
  READ_ONLY: "read-only",
  WORKSPACE_WRITE: "workspace-write",
  DANGER_FULL_ACCESS: "danger-full-access",
} as const);
export type RoleSandbox = ValueOf<typeof ROLE_SANDBOX>;
export const ROLE_SANDBOXES = frozenValues(ROLE_SANDBOX);
export const isRoleSandbox = (value: unknown): value is RoleSandbox =>
  memberOf(ROLE_SANDBOXES, value);

export const ROLE_FRONTMATTER_FIELD = Object.freeze({
  NAME: "name",
  DESCRIPTION: "description",
  TOOLS: "tools",
  MODEL: "model",
  SANDBOX: "sandbox",
  EXTENDS: "extends",
} as const);
export type RoleFrontmatterField = ValueOf<typeof ROLE_FRONTMATTER_FIELD>;
export const ROLE_FRONTMATTER_FIELDS = frozenValues(ROLE_FRONTMATTER_FIELD);
export const isRoleFrontmatterField = (value: unknown): value is RoleFrontmatterField =>
  memberOf(ROLE_FRONTMATTER_FIELDS, value);

export type RoleFrontmatterRecord = Partial<Record<RoleFrontmatterField, unknown>>;

/** Reject arrays, class instances, and inherited/prototype-polluted field authorities. */
export const isRoleFrontmatterRecord = (value: unknown): value is RoleFrontmatterRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (
      (prototype === null || prototype === Object.prototype) &&
      Object.keys(value).every(isRoleFrontmatterField)
    );
  } catch {
    return false;
  }
};
