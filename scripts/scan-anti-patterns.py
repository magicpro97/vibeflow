#!/usr/bin/env python3
"""Scan active project anti-patterns without requiring third-party tooling."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

FIELD_RE = re.compile(r"^(Pattern|Why|Scope files|Detection|Status|Guidance):\s*(.*)$")
HEADING_RE = re.compile(r"^## \[([^\]]+)\]")
SKIP_DIRS = {".git", "node_modules", ".vibeflow", ".agents", ".claude", ".github", ".opencode"}


def parse_registry(path: Path) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    for line in path.read_text(encoding="utf-8").splitlines():
        heading = HEADING_RE.match(line.strip())
        if heading:
            if current:
                entries.append(current)
            current = {"id": heading.group(1), "fields": {}}
            continue
        if current:
            match = FIELD_RE.match(line.strip())
            if match:
                fields = current["fields"]
                assert isinstance(fields, dict)
                fields[match.group(1)] = match.group(2)
    if current:
        entries.append(current)
    return [entry for entry in entries if isinstance(entry["fields"], dict) and entry["fields"].get("Status") == "active"]


def scope_matches(scopes: str, rel: str) -> bool:
    patterns = [part.strip() for part in scopes.split(",") if part.strip()]
    return not patterns or any(Path(rel).match(pattern) for pattern in patterns)


def scan(root: Path) -> list[dict[str, str]]:
    registry = root / ".vibeflow" / "knowledge" / "anti-patterns.md"
    if not registry.exists():
        return []
    findings: list[dict[str, str]] = []
    for entry in parse_registry(registry):
        fields = entry["fields"]
        assert isinstance(fields, dict)
        try:
            pattern = re.compile(str(fields["Pattern"]))
        except (KeyError, re.error) as error:
            findings.append({"id": str(entry["id"]), "error": f"invalid pattern: {error}"})
            continue
        for path in root.rglob("*"):
            if not path.is_file() or any(part in SKIP_DIRS for part in path.relative_to(root).parts):
                continue
            rel = path.relative_to(root).as_posix()
            if rel.startswith((".agents/skills/", ".claude/skills/", ".github/skills/", ".opencode/skills/")):
                continue
            if not scope_matches(str(fields.get("Scope files", "")), rel):
                continue
            try:
                for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                    if pattern.search(line):
                        findings.append({"id": str(entry["id"]), "file": rel, "line": str(line_no), "match": line.strip()[:200]})
            except UnicodeDecodeError:
                continue
    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--fail-on-active", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    findings = scan(args.root.resolve())
    if args.json:
        print(json.dumps(findings, ensure_ascii=False, indent=2))
    else:
        for finding in findings:
            print(f"[{finding['id']}] {finding.get('file', '')}:{finding.get('line', '')} {finding.get('match', finding.get('error', ''))}")
    return 1 if args.fail_on_active and findings else 0


if __name__ == "__main__":
    sys.exit(main())
