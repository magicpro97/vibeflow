import { ref } from "vue";
import { ENGINES, type Engine } from "../../../core/agent-contract.js";
import { CONVERSATION_ROLE_NAME } from "../../../core/role-name-contract.js";
import { HOME_API_ERROR_CONTRACT } from "../conversation-home-error-boundary.js";
import { conversationHomeRequest } from "../conversation-home-http.js";
import { HOME_ENGINE_DISPLAY_LABEL } from "../conversation-home-participant-label.js";
import type { HomeEngineStatusRow } from "../conversation-home-types.js";

export type HomeEngineSelection = "auto" | Engine;

export interface HomeEngineStatus {
  engine: Engine;
  level: string;
  detail: string;
  checkedAt?: string;
  available: boolean;
}

export const HOME_ENGINE_AUTO = "auto" as const;
export const HOME_ENGINE_AUTO_LABEL = "Auto" as const;

const STORAGE_KEY = "vf-engine";

function storedSelection(): HomeEngineSelection {
  if (typeof localStorage === "undefined") return HOME_ENGINE_AUTO;
  const value = localStorage.getItem(STORAGE_KEY);
  return ENGINES.includes(value as Engine) ? (value as Engine) : HOME_ENGINE_AUTO;
}

const _selection = ref<HomeEngineSelection>(storedSelection());
const _statuses = ref<HomeEngineStatus[]>([]);
const _checking = ref(false);
const _checkedAt = ref<number | null>(null);

/** Read-only access for the command runtime so create requests carry the pick. */
export function getHomePreferredEngine(): HomeEngineSelection {
  return _selection.value;
}

/** Participants override sent when a concrete CLI is picked; undefined = auto. */
export function homeCreateParticipants(): { role_ref: string; engine: Engine }[] | undefined {
  const preferred = getHomePreferredEngine();
  return preferred === HOME_ENGINE_AUTO
    ? undefined
    : [{ role_ref: CONVERSATION_ROLE_NAME.DIRECT, engine: preferred }];
}

function normalizeStatuses(rows: readonly HomeEngineStatusRow[]): HomeEngineStatus[] {
  const byEngine = new Map<string, HomeEngineStatusRow>();
  for (const row of rows) byEngine.set(row.engine, row);
  return ENGINES.map((engine) => {
    const row = byEngine.get(engine);
    return {
      engine,
      level: row?.level ?? "unknown",
      detail: row?.detail ?? "",
      ...(row?.checkedAt !== undefined ? { checkedAt: row.checkedAt } : {}),
      available: row?.level === "ready",
    };
  });
}

function fetchEngineStatuses(refresh: boolean): Promise<HomeEngineStatusRow[]> {
  return conversationHomeRequest<{ engines?: HomeEngineStatusRow[] }>(
    "GET",
    refresh ? "/api/engines?refresh=1" : "/api/engines",
    undefined,
    undefined,
    undefined,
    HOME_API_ERROR_CONTRACT.PUBLIC,
  ).then((body) => body.engines ?? []);
}

export function useHomeEngines() {
  async function load(refresh = false): Promise<void> {
    if (_checking.value) return;
    _checking.value = true;
    try {
      const rows = await fetchEngineStatuses(refresh);
      _statuses.value = normalizeStatuses(rows);
      _checkedAt.value = Date.now();
    } catch {
      // keep last-known statuses; the menu still shows them with the stale check time
    } finally {
      _checking.value = false;
    }
  }

  function statusFor(engine: Engine): HomeEngineStatus | undefined {
    return _statuses.value.find((row) => row.engine === engine);
  }

  function pick(selection: HomeEngineSelection): void {
    _selection.value = selection;
    if (typeof localStorage === "undefined") return;
    if (selection === HOME_ENGINE_AUTO) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, selection);
  }

  function displayLabel(engine: Engine): string {
    return HOME_ENGINE_DISPLAY_LABEL[engine];
  }

  return {
    selection: _selection,
    statuses: _statuses,
    checking: _checking,
    checkedAt: _checkedAt,
    load,
    statusFor,
    pick,
    displayLabel,
  };
}
