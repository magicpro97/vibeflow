import { ref, watch } from "vue";

type ColorScheme = "light" | "dark" | "system";
const STORAGE_KEY = "vf-color-scheme";

function getStored(): ColorScheme {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(STORAGE_KEY) as ColorScheme | null;
  return v === "light" || v === "dark" ? v : "system";
}

function apply(scheme: ColorScheme) {
  const html = document.documentElement;
  if (scheme === "system") {
    html.removeAttribute("data-color-scheme");
  } else {
    html.setAttribute("data-color-scheme", scheme);
  }
}

const _current = ref<ColorScheme>(getStored());
let _initialized = false;

/** Label & accessible text for each scheme */
export const SCHEME_LABELS: Record<ColorScheme, string> = {
  light: "Light mode",
  dark: "Dark mode",
  system: "System theme",
};

export function useColorScheme() {
  if (!_initialized) {
    _initialized = true;
    apply(_current.value);

    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", () => {
      if (_current.value === "system") apply("system");
    });

    watch(_current, (val) => {
      if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, val);
      apply(val);
    });
  }

  function toggle() {
    const order: ColorScheme[] = ["light", "dark", "system"];
    const idx = Math.max(0, order.indexOf(_current.value));
    _current.value = order[(idx + 1) % order.length] ?? "light";
  }

  return { current: _current, toggle };
}
