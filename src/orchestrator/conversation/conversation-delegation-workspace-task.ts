import { conversationDelegationOracleInvocation } from "./conversation-delegation-workspace-contract.js";
import {
  CONVERSATION_DELEGATION_DIGEST,
  CONVERSATION_DELEGATION_WORKSPACE_LIMIT,
  type ConversationDelegationWorkspaceRecordV1,
} from "./conversation-delegation-workspace-records.js";

export interface ConversationDelegationTaskBindingV1 {
  task_id: string;
  contract_digest: string;
  scope: readonly string[];
  forbidden: readonly string[];
  verify_oracles: readonly string[];
}

export interface ConversationDelegationTaskCompletionV1 {
  task_id: string;
  changed_paths: readonly string[];
  commands: readonly string[];
}

const fail = (message: string): never => {
  throw new Error(message);
};
const compareCanonicalText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const boundedText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= CONVERSATION_DELEGATION_WORKSPACE_LIMIT.TEXT_BYTES &&
  !/[\0\r\n]/u.test(value);

export function isCanonicalDelegationPath(value: unknown, allowDirectory = false): value is string {
  if (!boundedText(value) || value.startsWith("/") || value.includes("\\")) return false;
  const directory = allowDirectory && value.endsWith("/");
  const body = directory ? value.slice(0, -1) : value;
  return (
    body.length > 0 &&
    !body.endsWith("/") &&
    body.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function canonicalList(
  values: readonly string[],
  label: string,
  validate: (value: string) => boolean,
  allowEmpty = false,
  sortValues = true,
): string[] {
  if (
    !Array.isArray(values) ||
    (!allowEmpty && values.length === 0) ||
    values.length > CONVERSATION_DELEGATION_WORKSPACE_LIMIT.LIST_ITEMS ||
    values.some((value) => !validate(value)) ||
    new Set(values).size !== values.length
  )
    fail(`invalid coordination ${label}`);
  return sortValues ? [...values].sort(compareCanonicalText) : [...values];
}

export function canonicalTaskBinding(task: ConversationDelegationTaskBindingV1): {
  task_id: string;
  contract_digest: string;
  scope: string[];
  forbidden: string[];
  verify_oracles: string[];
} {
  if (!boundedText(task.task_id) || !CONVERSATION_DELEGATION_DIGEST.test(task.contract_digest))
    fail("invalid coordination task binding");
  const scope = canonicalList(task.scope, "task scope", (value) =>
    isCanonicalDelegationPath(value, true),
  );
  const forbidden = canonicalList(
    task.forbidden,
    "task forbidden selectors",
    (value) => isCanonicalDelegationPath(value, true),
    true,
  );
  const verifyOracles = canonicalList(
    task.verify_oracles,
    "verification oracles",
    (value) => boundedText(value) && conversationDelegationOracleInvocation(value) !== null,
    false,
    false,
  );
  return {
    task_id: task.task_id,
    contract_digest: task.contract_digest,
    scope,
    forbidden,
    verify_oracles: verifyOracles,
  };
}

export function canonicalTaskCompletion(completion: ConversationDelegationTaskCompletionV1): {
  task_id: string;
  changed_paths: string[];
  commands: string[];
} {
  if (!boundedText(completion.task_id)) fail("invalid coordination task completion");
  return {
    task_id: completion.task_id,
    changed_paths: canonicalList(
      completion.changed_paths,
      "completion paths",
      (value) => isCanonicalDelegationPath(value),
      true,
    ),
    commands: canonicalList(
      completion.commands,
      "verification commands",
      boundedText,
      false,
      false,
    ),
  };
}

export function taskBindingMatches(
  record: ConversationDelegationWorkspaceRecordV1,
  task: ReturnType<typeof canonicalTaskBinding>,
): boolean {
  return (
    record.task_id === task.task_id &&
    record.task_contract_digest === task.contract_digest &&
    record.task_scope.length === task.scope.length &&
    record.task_scope.every((scope, index) => scope === task.scope[index]) &&
    record.task_forbidden.length === task.forbidden.length &&
    record.task_forbidden.every((selector, index) => selector === task.forbidden[index]) &&
    record.task_verify_oracles.length === task.verify_oracles.length &&
    record.task_verify_oracles.every((oracle, index) => oracle === task.verify_oracles[index])
  );
}

const selectorMatchesPath = (selector: string, path: string): boolean => {
  const directory = selector.endsWith("/");
  const body = directory ? selector.slice(0, -1) : selector;
  return directory ? path.startsWith(`${body}/`) : path === body || path.startsWith(`${body}/`);
};

export function assertChangedPathsInScope(
  paths: readonly string[],
  scope: readonly string[],
): void {
  const outside = paths.filter(
    (path) => !scope.some((selector) => selectorMatchesPath(selector, path)),
  );
  if (outside.length > 0)
    fail(`coordination task changed paths outside scope: ${outside.join(", ")}`);
}

export function assertChangedPathsNotForbidden(
  paths: readonly string[],
  forbidden: readonly string[],
): void {
  const denied = paths.filter((path) =>
    forbidden.some((selector) => selectorMatchesPath(selector, path)),
  );
  if (denied.length > 0) fail(`coordination task changed forbidden paths: ${denied.join(", ")}`);
}
