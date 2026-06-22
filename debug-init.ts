
import { init } from "./src/commands.js";
const code = await init(
  { "no-ai": true, engine: "claude", "no-memory": true, "no-hooks": true },
  {
    preflight: () => [{ engine: "claude", level: "ready", detail: "test stub", checkedAt: "" }],
    hasCommandFn: (cmd) => cmd === "codegraph" ? false : true,
    syncSpawner: (cmd, args) => ({ status: 0 }),
    answers: { goal: "test", engines: ["claude"] },
  }
);
console.log("exit:", code);
