import { rmSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME || process.env.USERPROFILE;
if (home) rmSync(join(home, ".vibeflow", "projects.json"), { force: true });
