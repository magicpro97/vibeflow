import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HookInput, HookResult } from "../core.js";
import {
  type HookConfirmationDecision,
  isHookConfirmationDecision,
} from "../core/hook-contract.js";
import { UI_HOOK_ROUTE, resolveUiServerDiscovery } from "../core/ui-cli-contract.js";

interface HookUiClientDependencies {
  readonly fetch?: typeof fetch;
  readonly readText?: (path: string) => string;
  readonly uuid?: () => string;
}

function readHookOrigin(discoveryPath: string, readText: (path: string) => string): string | null {
  try {
    const discovery = resolveUiServerDiscovery(JSON.parse(readText(discoveryPath)));
    return discovery?.hook_origin ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve one hook decision through the credential-free loopback approval channel.
 * Returns null when discovery or transport is unavailable so the caller remains fail-closed.
 */
export async function requestUiHookApproval(
  discoveryPath: string,
  input: HookInput,
  result: HookResult,
  dependencies: HookUiClientDependencies = {},
): Promise<HookConfirmationDecision | null> {
  const request = dependencies.fetch ?? fetch;
  const readText = dependencies.readText ?? ((path: string) => readFileSync(path, "utf8"));
  const origin = readHookOrigin(discoveryPath, readText);
  if (!origin) return null;
  const id = (dependencies.uuid ?? randomUUID)();
  try {
    const pending = await request(`${origin}${UI_HOOK_ROUTE.PENDING}`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, input, result }),
    });
    if (!pending.ok) return null;
    const response = await request(`${origin}${UI_HOOK_ROUTE.RESPONSE_PREFIX}${id}`, {
      redirect: "error",
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { decision?: unknown };
    return isHookConfirmationDecision(payload.decision) ? payload.decision : null;
  } catch {
    return null;
  }
}
