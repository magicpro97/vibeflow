import { c } from "../core.js";
import { out } from "../logbus.js";
import { registryAdd, registryList, registryUpdate } from "./registry-channel.js";
import { registryInstall } from "./registry-install.js";

const COLLISION_OPTIONS = new Set(["skip", "replace", "rename"]);
const INSTALL_USAGE =
  "Usage: vf skills registry install <registry-id>/<skill-name> [--version <v>] [--on-collision skip|replace|rename] [--record-review] [--yes]";

export function handleRegistrySubcommand(repo: string, args: string[]): number {
  const cmd = args[0];
  const rest = args.slice(1);
  if (cmd === "add") {
    let url = "";
    let name = "";
    let ref = "";
    let yes = false;
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (tok === "--name") name = rest[++i] ?? "";
      else if (tok?.startsWith("--name=")) name = tok.slice(7);
      else if (tok === "--ref") ref = rest[++i] ?? "";
      else if (tok?.startsWith("--ref=")) ref = tok.slice(6);
      else if (tok === "--yes") yes = true;
      else if (tok?.startsWith("--") || url) {
        out(
          "vf",
          c.red(
            "Usage: vf skills registry add <git-url> --name <id> --ref <tag-or-commit> [--yes]",
          ),
          { level: "error" },
        );
        return 2;
      } else if (tok !== undefined) url = tok;
    }
    if (!url || !name || !ref) {
      out(
        "vf",
        c.red("Usage: vf skills registry add <git-url> --name <id> --ref <tag-or-commit> [--yes]"),
        { level: "error" },
      );
      return 2;
    }
    return registryAdd(repo, url, name, ref, { yes });
  }
  if (cmd === "list") {
    if (rest.length) {
      out("vf", c.red("Usage: vf skills registry list — no arguments or flags supported."), {
        level: "error",
      });
      return 2;
    }
    return registryList(repo);
  }
  if (cmd === "update") {
    let id: string | undefined;
    let yes = false;
    for (const tok of rest) {
      if (tok === "--yes") yes = true;
      else if (tok?.startsWith("--") || id) {
        out("vf", c.red("Usage: vf skills registry update [<id>] [--yes]"), { level: "error" });
        return 2;
      } else id = tok;
    }
    return registryUpdate(repo, id, { yes });
  }
  if (cmd === "install") {
    let target = "";
    let version: string | undefined;
    let onCollision: "skip" | "replace" | "rename" = "skip";
    let yes = false;
    let recordReview = false;
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      if (tok === "--version") version = rest[++i] ?? "";
      else if (tok?.startsWith("--version=")) version = tok.slice(10);
      else if (tok === "--on-collision" || tok?.startsWith("--on-collision=")) {
        const value = tok === "--on-collision" ? (rest[++i] ?? "") : tok.slice(15);
        if (!COLLISION_OPTIONS.has(value)) {
          out("vf", c.red(`--on-collision must be skip, replace, or rename, got "${value}".`), {
            level: "error",
          });
          return 2;
        }
        onCollision = value as "skip" | "replace" | "rename";
      } else if (tok === "--yes") yes = true;
      else if (tok === "--record-review") recordReview = true;
      else if (tok?.startsWith("--") || target) {
        out("vf", c.red(INSTALL_USAGE), { level: "error" });
        return 2;
      } else if (tok !== undefined) target = tok;
    }
    const slash = target.indexOf("/");
    if (slash <= 0 || slash === target.length - 1) {
      out("vf", c.red(INSTALL_USAGE), { level: "error" });
      return 2;
    }
    return registryInstall(repo, target.slice(0, slash), target.slice(slash + 1), {
      version,
      onCollision,
      yes,
      recordReview,
    });
  }
  out("vf", c.red("Usage: vf skills registry <add|list|update|install> [args]"), {
    level: "error",
  });
  return 2;
}
