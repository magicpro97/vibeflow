# Anti-pattern registry

Append-only record of confirmed VibeFlow regressions. Active entries are injected into
scoped dispatch prompts and checked by `scripts/scan-anti-patterns.py`.

## [AP-001] Shared browser fixture root causes concurrent-run deletion
Pattern: \\.e2e-workspace
Why: Concurrent Playwright invocations can remove a shared fixture while another run still owns it.
Scope files: e2e/**, scripts/**, playwright.config.ts
Detection: regex scanner plus review
Status: active
Guidance: Give every E2E invocation a unique workspace and remove it only after quiescence.

## [AP-002] Source-text-only test hides runtime behavior
Pattern: ^\s*(?:expect\()?(?:readFileSync|Path\.read_text)\(
Why: Source assertions can pass while the real route, handler, or process path remains broken.
Scope files: test/anti-patterns.test.ts, test/**/source-contract*.test.ts
Detection: regex scanner plus behavioral review
Status: active
Guidance: Invoke production behavior through a narrow injected seam; reserve source scans for structural contracts.

## [AP-003] Broad staging sweeps unrelated changes
Pattern: ^\s*git\s+add\s+-A\s*$
Why: Broad staging can commit generated files, secrets, or another worker's edits.
Scope files: .github/**, scripts/**, .vibeflow/**
Detection: regex scanner plus review
Status: active
Guidance: Stage explicit paths and inspect `git diff --cached` before committing.

## [AP-004] Unverified skill is treated as proof
Pattern: ^\s*status:\s*verified\s*$
Why: A self-declared status does not prove skill safety or correctness at a trust boundary.
Scope files: src/skills/**, .vibeflow/skills/**
Detection: registry validator and review
Status: active
Guidance: Validate provenance, run the skill gate, and promote only with recorded evidence.

## [AP-005] Fixed sleep substitutes for lifecycle ownership
Pattern: ^\s*setTimeout\(
Why: Elapsed time does not prove streams, callbacks, processes, or fixture users are quiescent.
Scope files: src/**, test/**, e2e/**
Detection: regex scanner plus lifecycle review
Status: active
Guidance: Await an observable completion barrier; use bounded timeouts only as typed failure guards.

## [AP-006] Generated pointer mirrors fail content-only contracts
Pattern: \bCanonical skill lives at:
Why: Pointer mirrors intentionally omit canonical body content, so callers that validate or test mirror content directly fail even though runtime can resolve the canonical source.
Scope files: src/workflow/**, src/skills/**, test/**
Detection: mirror parity test plus review
Status: active
Guidance: Choose pointer mode only for engines that resolve canonical files; use full mode when a consumer requires self-contained mirror content.
