import { createHash } from "node:crypto";
import type { CapabilityManifestV1 } from "../../src/capabilities/manifest/index.js";

export const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export function roleManifest(): {
  manifest: CapabilityManifestV1;
  files: Map<string, Uint8Array>;
} {
  const role = Buffer.from("# Reviewer\n", "utf8");
  return {
    files: new Map([
      ["capability.json", Buffer.alloc(0)],
      ["roles/reviewer.md", role],
    ]),
    manifest: {
      schema_version: "1.0",
      id: "acme.reviewer",
      version: "1.2.3",
      metadata: {
        display_name: "Reviewer",
        summary: "Adds a bounded reviewer role.",
        homepage_url: null,
        documentation_url: null,
        icon: null,
      },
      compatibility: { vf: ">=0.15.0 <1.0.0", engines: { codex: ">=1.0.0 <2.0.0" } },
      components: [
        {
          type: "role",
          component_id: "reviewer",
          targets: ["codex"],
          required: true,
          role_spec_path: "roles/reviewer.md",
          role_spec_sha256: sha(role),
        },
      ],
      dependencies: [],
      conflicts: [],
      permissions: [
        {
          permission_id: "acme.reviewer/project-read",
          required_enforcement: "sandboxed",
          kind: "filesystem",
          scope: { root: "project", access: "read", path_prefix: "src" },
        },
      ],
      inputs: [],
      health: [],
    },
  };
}
