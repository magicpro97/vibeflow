import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CTX_DIR } from "../src/core.js";
import { buildCuratorWorkflow } from "../src/curator-setup.js";
import { startServer } from "../src/server.js";

const TARGET = join(".github", "workflows", "skill-curator.yml");

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "vf-curator-setup-"));
}

async function csrfToken(url: string): Promise<string> {
  const res = await fetch(url);
  const html = await res.text();
  const m = html.match(/<meta\s+name="vf-token"\s+content="([^"]+)"\s*\/?>/i);
  if (!m) throw new Error("CSRF token not found");
  return m[1] as string;
}

describe("POST /api/curator/setup/preview — integrated #693", () => {
  test("returns exact target diff + never writes", async () => {
    const dir = tmpRepo();
    const orig = process.cwd();
    try {
      process.chdir(dir);
      const { server, url } = await startServer(0);
      try {
        const token = await csrfToken(url);
        await fetch(`${url}/api/detect`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({ path: dir }),
        });
        const res = await fetch(`${url}/api/curator/setup/preview`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          id: string;
          target: string;
          existing: boolean;
          diff: string;
        };
        expect(body.id).toBeTruthy();
        expect(body.target).toBe(".github/workflows/skill-curator.yml");
        expect(body.existing).toBe(false);
        expect(body.diff).toContain("+name: Skill Curator Weekly Report");
        // preview must not create the file
        const onDisk = Bun.file(join(dir, TARGET));
        expect(await onDisk.exists()).toBe(false);
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("whole flow: preview → apply writes exact file + audit evidence", async () => {
    const dir = tmpRepo();
    const orig = process.cwd();
    try {
      process.chdir(dir);
      const { server, url } = await startServer(0);
      try {
        const token = await csrfToken(url);
        await fetch(`${url}/api/detect`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({ path: dir }),
        });
        const previewRes = await fetch(`${url}/api/curator/setup/preview`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({}),
        });
        const preview = (await previewRes.json()) as { id: string; currentHash: string };
        const applyRes = await fetch(`${url}/api/curator/setup/apply`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({
            previewId: preview.id,
            currentHash: preview.currentHash,
            confirmationText: "CREATE CURATOR WORKFLOW",
          }),
        });
        expect(applyRes.status).toBe(200);
        const onDisk = await Bun.file(join(dir, TARGET)).text();
        expect(onDisk).toBe(buildCuratorWorkflow());
        // audit evidence recorded locally, no file content leaked
        const auditPath = join(dir, CTX_DIR, "logs", "skill-audit.jsonl");
        const audit = await Bun.file(auditPath).text();
        expect(audit).toContain("curator-setup");
        expect(audit).toContain("preview:");
        expect(audit).not.toContain(buildCuratorWorkflow().slice(0, 40));
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("apply with wrong confirmation → 400, file not created", async () => {
    const dir = tmpRepo();
    const orig = process.cwd();
    try {
      process.chdir(dir);
      const { server, url } = await startServer(0);
      try {
        const token = await csrfToken(url);
        await fetch(`${url}/api/detect`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({ path: dir }),
        });
        const previewRes = await fetch(`${url}/api/curator/setup/preview`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({}),
        });
        const preview = (await previewRes.json()) as { id: string; currentHash: string };
        const applyRes = await fetch(`${url}/api/curator/setup/apply`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({
            previewId: preview.id,
            currentHash: preview.currentHash,
            confirmationText: "wrong",
          }),
        });
        expect(applyRes.status).toBe(400);
        expect(await Bun.file(join(dir, TARGET)).exists()).toBe(false);
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("existing file: preview reports existing=true, apply replaces it only after confirmation", async () => {
    const dir = tmpRepo();
    const orig = process.cwd();
    try {
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(join(dir, TARGET), "name: Old Report\n");
      process.chdir(dir);
      const { server, url } = await startServer(0);
      try {
        const token = await csrfToken(url);
        await fetch(`${url}/api/detect`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({ path: dir }),
        });
        const previewRes = await fetch(`${url}/api/curator/setup/preview`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({}),
        });
        const preview = (await previewRes.json()) as {
          id: string;
          currentHash: string;
          existing: boolean;
        };
        expect(preview.existing).toBe(true);
        const applyRes = await fetch(`${url}/api/curator/setup/apply`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({
            previewId: preview.id,
            currentHash: preview.currentHash,
            confirmationText: "CREATE CURATOR WORKFLOW",
          }),
        });
        expect(applyRes.status).toBe(200);
        expect(await Bun.file(join(dir, TARGET)).text()).toBe(buildCuratorWorkflow());
      } finally {
        server.stop();
      }
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
