---
name: ci-flake-triage
description: Use when CI checks fail intermittently, a pull request has conflicting run results, or a failure must be classified as infrastructure noise versus a code regression on the exact head.
metadata:
  scope: project
  project: magicpro97/vibeflow
  status: verified
---

# CI Flake Triage

Treat every red CI result as a real signal until its root cause is proven. A later green run does not erase a failure or prove that code is safe; evidence must stay bound to the exact commit under test.

## When to use

- A CI job is flaky, intermittent, timing-sensitive, or contradictory across runs.
- A pull request has red and green results that may belong to different SHAs.
- A reviewer needs an infrastructure-versus-regression classification backed by logs.

## When not to use

- The task is ordinary local test debugging with no CI run or hosted-runner evidence.
- The failure is already deterministic and its root cause is known; use the project’s normal fix-and-verify flow.
- The request is to hide a failing gate, weaken CI, or make a merge appear green.

## Steps

1. Pin the exact head. Record `git rev-parse HEAD`, pull-request head SHA, workflow run ID, job name, matrix values, and runner/platform. Ignore logs, approvals, or coverage from another SHA. Any code change, rebase, or force-push starts triage again.
2. Capture the first failure before rerunning. Save the failed step, full failed-job log or artifact URL, timestamps, assertion/error text, exit status, and relevant runner/dependency/service context. Read the failure, not only the check summary.
3. Trace root cause. Separate the first causal error from downstream cancellations, timeouts, and cleanup noise. Reproduce the same command or test locally when possible, but do not substitute local results for exact-head CI evidence.
4. Classify with evidence:
   - **Regression:** deterministic failure, new assertion/type/build error, or reproduction tied to changes on the exact head.
   - **Infrastructure:** runner provisioning failure, unavailable external service, dependency/download outage, or platform fault with no code-level failure; corroborate with runner/service evidence.
   - **Inconclusive:** conflicting or incomplete evidence. Keep it open; do not label it infrastructure to unblock merge.
5. Run controlled serial reruns only after evidence capture: rerun one failed job at a time, on the same exact SHA, and record each run ID and result in order. Reruns collect evidence; they do not make a failure green, and a pass does not prove root cause.
6. Act on classification. Fix the code or test for a regression. Repair or escalate the runner, workflow, dependency, or service fault for infrastructure. Do not add waivers, automatic retries, sleep-based masking, or `--no-verify` bypasses.
7. Re-verify after the root-cause change. A new SHA invalidates prior triage; repeat exact-head capture, failed-log capture, and required gates from step 1.
8. Publish an evidence record containing exact SHA, run/job IDs, ordered reruns, failure excerpts and URLs, environment, classification, root cause, action taken, and remaining uncertainty.

## Verification

- All cited logs and artifacts belong to exact head under review.
- Root-cause error is distinguished from downstream noise.
- Infra, regression, or inconclusive classification has supporting evidence.
- Serial reruns are ordered, bounded, and recorded; no automated retry policy hides failures.
- Required gates pass on the final exact head after any fix, with no waiver and no `--no-verify` bypass.
- Evidence record is sufficient for another engineer to reproduce the diagnosis.
