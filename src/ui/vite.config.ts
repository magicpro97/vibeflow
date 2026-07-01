import { presetWind } from "@unocss/preset-wind";
import vue from "@vitejs/plugin-vue";
import UnoCSS from "unocss/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [
    vue(),
    UnoCSS({
      presets: [presetWind()],
      theme: {
        fontFamily: {
          // Hanken Grotesk — self-hosted at /assets/fonts/, loaded via server.ts /assets/* route
          // Similar to Inter: geometric, neutral, excellent screen legibility at 11-14px
          sans: "'Hanken Grotesk', ui-sans-serif, system-ui, -apple-system, sans-serif",
          mono: "ui-monospace, 'SF Mono', 'Cascadia Code', monospace",
        },
      },
      shortcuts: {
        // Tactile feedback (taste-skill §4.5) + visible focus ring (WCAG 2.1 §2.4.7)
        "btn-tactile":
          "active:scale-98 active:-translate-y-px transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-950",
        "btn-primary":
          "btn-tactile px-4 py-2 rounded bg-white text-neutral-900 hover:bg-neutral-100 disabled:opacity-40 text-sm font-medium transition-colors",
        "btn-secondary":
          "btn-tactile px-3 py-1.5 rounded border border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 disabled:opacity-40 text-sm transition-colors",
        "btn-ghost":
          "btn-tactile px-2 py-1 rounded text-xs text-neutral-500 hover:text-neutral-200 disabled:opacity-30 transition-colors",
        // Input with consistent focus style
        "input-base":
          "bg-transparent border border-neutral-800 rounded px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/20 focus:border-neutral-600 transition-all",
      },
    }),
  ],
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split vendor libs (vue + pinia) into a separate chunk so browser
        // can cache them independently of app code changes.
        manualChunks: {
          vendor: ["vue", "pinia"],
        },
      },
    },
  },
  base: command === "build" ? "/ui/" : "/",
  server: {
    proxy: {
      "/api": "http://localhost:7799",
      "/state": "http://localhost:7799",
      "/assets": "http://localhost:7799",
    },
  },
}));
