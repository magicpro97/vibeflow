#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");

function parseWaiverMetadata(text) {
  const full = text.match(
    /waiver\s*:\s*"?\s*#(\d+)\s+owner:([A-Za-z0-9-]+)\s+expires:(\d{4}-\d{2}-\d{2})/,
  );
  if (full) return { issue: full[1], owner: full[2], expires: full[3] };
  const hasWaiver = /waiver\s*:/i.test(text);
  if (!hasWaiver) return null;
  const issue = text.match(/#\s*(\d+)/)?.[1] || null;
  const owner = text.match(/owner:([A-Za-z0-9-]+)/)?.[1] || null;
  const expires = text.match(/expires:(\d{4}-\d{2}-\d{2})/)?.[1] || null;
  return { issue, owner, expires };
}

function realDateParts(ymd) {
  const parts = ymd.split("-").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  const [y, m, d] = parts;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { y, m, d };
}

function validateWaiver(meta, label, todayStr) {
  if (!meta)
    return `${label}: missing waiver metadata (expected "waiver: #<issue> owner:<login> expires:<YYYY-MM-DD>")`;
  if (!meta.issue) return `${label}: missing issue number`;
  if (!meta.owner) return `${label}: missing owner`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.expires))
    return `${label}: invalid date format "${meta.expires}"`;
  const dp = realDateParts(meta.expires);
  if (!dp) return `${label}: invalid calendar date "${meta.expires}"`;
  const today = todayStr ? realDateParts(todayStr) : null;
  if (!today && todayStr) return `${label}: invalid today "${todayStr}"`;
  const t =
    today ||
    (() => {
      const d = new Date();
      return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
    })();
  const expiryEpoch = Date.UTC(dp.y, dp.m - 1, dp.d);
  const todayEpoch = Date.UTC(t.y, t.m - 1, t.d);
  if (expiryEpoch < todayEpoch) return `${label}: expired ${meta.expires}`;
  return null;
}

function checkInlineWaivers(fileRel, text, todayStr) {
  const errors = [];
  const lines = text.split("\n");
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (i === 0 && line.startsWith("#!")) continue;
    if (t === "") continue;
    if (!inBlock && t.startsWith("/*")) {
      if (t.includes("*/")) continue;
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      continue;
    }
    if (
      /^(?:import|export|function|class|const|let|var|type|interface|declare|namespace|module)\b/.test(
        t,
      )
    )
      break;
    if (!line.trimStart().startsWith("//")) break;
    if (!line.includes("size-waiver:")) continue;
    const meta = parseWaiverMetadata(line);
    const err = validateWaiver(meta, `${fileRel}:${i + 1}`, todayStr);
    if (err) errors.push(err);
  }
  return errors;
}

function scanWaiversArrayFile(filePath, varName, label, todayStr) {
  const errors = [];
  if (!fs.existsSync(filePath)) return errors;
  const text = fs.readFileSync(filePath, "utf8");
  const re = new RegExp(`const\\s+${varName}\\s*=\\s*(?:new\\s+Map\\s*\\(\\s*)?\\[`);
  const m = re.exec(text);
  if (!m) return errors;
  let depth = 0;
  let start = -1;
  for (let i = m.index; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) {
        const arrContent = text.slice(start + 1, i);
        const objRe = /\{([^{}]*)\}/g;
        let om;
        while (true) {
          om = objRe.exec(arrContent);
          if (om === null) break;
          const obj = om[1];
          const metaMatch = obj.match(/meta\s*:\s*"(waiver:[^"]+)"|meta\s*:\s*'(waiver:[^']+)'/);
          if (!metaMatch) {
            errors.push(
              `${label}: missing waiver metadata in entry (expected meta: "waiver: #<issue> owner:<login> expires:<YYYY-MM-DD>")`,
            );
            continue;
          }
          const raw = metaMatch[1] || metaMatch[2];
          const meta = parseWaiverMetadata(raw);
          const err = validateWaiver(meta, `${label} entry (${raw})`, todayStr);
          if (err) errors.push(err);
        }
        return errors;
      }
    }
  }
  return errors;
}

function scanWaivers(repoRoot, todayStr) {
  const errors = [];
  const srcDir = path.join(repoRoot, "src");
  function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
  }
  if (fs.existsSync(srcDir)) {
    for (const file of walk(srcDir)) {
      const rel = path.relative(repoRoot, file);
      errors.push(...checkInlineWaivers(rel, fs.readFileSync(file, "utf8"), todayStr));
    }
  }
  errors.push(
    ...scanWaiversArrayFile(
      path.join(repoRoot, "scripts", "check-file-size.cjs"),
      "WAIVERS",
      "WAIVERS",
      todayStr,
    ),
  );
  errors.push(
    ...scanWaiversArrayFile(
      path.join(repoRoot, "scripts", "coverage-gate.cjs"),
      "COVERAGE_WAIVERS",
      "COVERAGE_WAIVERS",
      todayStr,
    ),
  );
  return errors;
}

function main() {
  const REPO_ROOT = path.resolve(__dirname, "..");
  const errors = scanWaivers(REPO_ROOT);
  if (errors.length === 0) {
    console.log("waiver:check OK");
    process.exit(0);
  }
  for (const e of errors) {
    console.error(`::error::${e}`);
  }
  console.error(`waiver:check FAILED (${errors.length} error(s))`);
  process.exit(1);
}

if (require.main === module) main();
module.exports = {
  parseWaiverMetadata,
  validateWaiver,
  realDateParts,
  checkInlineWaivers,
  scanWaiversArrayFile,
  scanWaivers,
};
