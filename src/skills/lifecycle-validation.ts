// #660: lifecycle validation helpers — returns string warnings
export function validateLifecycleOwners(data: Record<string, unknown>): string[] {
  const w: string[] = [];
  if (data.owners !== undefined) {
    if (!Array.isArray(data.owners)) {
      w.push("frontmatter.owners must be an array of strings");
    } else if (data.owners.length === 0) {
      w.push("frontmatter.owners must be a nonempty array when present");
    } else {
      for (const o of data.owners) {
        if (typeof o !== "string" || !/^[a-zA-Z0-9._@+-]+$/.test(o)) {
          w.push(`frontmatter.owners contains invalid value: "${String(o)}"`);
        }
      }
    }
  } else if (data.scope === "organization") {
    w.push("organization-scoped skill should declare frontmatter.owners for team accountability");
  }
  return w;
}

export function validateLifecycleChangelog(data: Record<string, unknown>): string[] {
  const w: string[] = [];
  if (data.changelog !== undefined) {
    if (!Array.isArray(data.changelog)) {
      w.push("frontmatter.changelog must be an array");
    } else {
      for (const entry of data.changelog) {
        if (typeof entry !== "string" || !entry.trim()) {
          w.push(`frontmatter.changelog contains invalid entry: "${String(entry)}"`);
        }
      }
    }
  }
  return w;
}

export function validateLifecycleSupersedes(data: Record<string, unknown>): string[] {
  const w: string[] = [];
  if (data.supersedes !== undefined) {
    if (typeof data.supersedes !== "string" || !data.supersedes.trim()) {
      w.push("frontmatter.supersedes must be a nonempty string");
    } else if (!/^[a-z0-9][a-z0-9-]*$/.test(data.supersedes.trim())) {
      w.push(
        `frontmatter.supersedes must match [a-z0-9][a-z0-9-]* (got "${data.supersedes.trim()}")`,
      );
    }
  }
  if (data.status === "deprecated" && !data.supersedes) {
    w.push("deprecated skill should declare frontmatter.supersedes to name the replacement skill");
  }
  return w;
}
