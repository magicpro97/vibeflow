# World-class code review — industry basis for the cross-review skill

The `cross-review` SKILL.md is the operational gate. This reference records the
industry sources behind it, so the rules aren't folklore. All sources were
fetched and read 2026-06-24; citations point to the source document.

## 1. Goal of review (Google Engineering Practices — standard.md)
Review exists to keep **overall code health improving over time**, not to hunt
bugs and not to demand perfection. Approve once a change *definitely improves*
code health even if imperfect ("there is no perfect code, only better code");
never accept a change that degrades code health.

Adjudication principles (standard.md):
- Technical facts & data overrule opinions / personal preference.
- Style → the style guide is authority; outside it, defer to surrounding code.
- Software *design* is rarely pure preference — weigh on engineering principles;
  if the author shows several approaches are equally valid, accept the author's.

→ In the skill: the verdict ladder (APPROVE / CHANGES REQUESTED / REJECT) and the
"don't block on linter-enforced style" rule.

## 2. What to look for, in priority order (Google looking-for.md; Microsoft 2-pass)
Design first, then quality. Microsoft Eng Playbook reviewer-guidance runs it as
two passes: **Pass 1 Design** (PR overview, architecture, user-facing) → **Pass 2
Code Quality** (complexity, naming, error handling, functionality, style, tests).
Concrete heuristics worth keeping:
- Over-engineering is a defect: "solve the problem you have NOW, not a speculated
  future one" (Google looking-for).
- ">3 arguments ⇒ potentially overly complex"; "one function, one job" (MS).
- Race conditions / parallel logic need careful reading — they don't surface by
  running the code (Google looking-for; MS).

→ In the skill: Lens 2 (Design) and Lens 1 (Correctness) checklists.

## 3. Size & time limits (SmartBear / Cisco study — real numbers)
- Review **no more than 200–400 LOC at a time**; past 400 LOC defect-detection drops.
- Inspection rate **under 500 LOC/hour**; **no more than 60 minutes** at a stretch.
- Authors should **annotate the change** before review (self-review / good PR body).

→ In the skill: the "split diffs > 500 lines / quality drops past 200-300" pitfall,
now with the SmartBear basis.

## 4. Comment grammar (Google comments.md → Conventional Comments v1.0)
Google "label comment severity": differentiate required changes from suggestions,
or authors read every comment as mandatory. Conventional Comments formalizes it:

    <label> [decoration]: <subject>

- labels: `issue`, `suggestion`, `nitpick` (trivial, non-blocking), `question`
  (unsure — ask), `praise`, `thought`/`note`.
- decorations: `(blocking)`, `(non-blocking)`, `(if-minor)`.
Be kind: comment on the *code*, not the *developer*; prefer "this line / we" over
"you"; always explain *why* (Google comments.md; MS playbook "Be Considerate").

→ In the skill: §3 finding grammar (`[SEVERITY] label(decoration): file:line`).

## 5. Understanding & alternatives are core (Bacchelli & Bird, ICSE 2013)
"Expectations, Outcomes, and Challenges of Modern Code Review" (Microsoft Research,
ICSE 2013), from observing/interviewing/surveying developers + classifying hundreds
of review comments: *finding defects is the main motivation, but reviews are LESS
about defects than expected* — the durable value is **knowledge transfer, team
awareness, and creation of alternative solutions**, and **code/change understanding
is the key aspect of review**.

→ In the skill: the "Step 0 — prove you understand" section and the
"Alternatives & what's good" report section.

## 6. Security review (OWASP Code Review Guide v2 + MS playbook)
On every new read/write or external boundary: injection, untrusted deserialization,
**authz on new paths**, cross-tenant/segment leakage, secrets in code, and
**PII/EUII written to logs** (MS reviewer-guidance: "Are we logging any PII
information?"). For an isolation finding, identify WHICH LAYER owns isolation (app
vs gateway/mTLS) before rating severity — app-layer is the only control when
there's no network/VPC backstop.

→ In the skill: Lens 3 (Risk) authz + PII-in-logs checklist items.

## 7. Pushback & deferral (Google pushback.md)
First consider the author may be right (they're closer to the code). If you still
disagree, explain with NEW evidence, not repetition. Beware "I'll fix it later" —
it usually never happens; fix in-change or require a filed ticket + `TODO(#id)`.
Don't block on out-of-scope adjacent issues — file them separately.

→ In the skill: the "clean it up later" and "out-of-scope" pitfalls.

## 8. Multi-engine specifics (cross-review's own value, confirmed by practice)
- **Independence + cross-engine**: a different engine reviews the implementer
  (codex↔claude). An engine reviewing its own work is blind to its own patterns.
- **Convergence = signal**: a finding 2+ engines independently raise is high-prior;
  a lone finding is a hypothesis the orchestrator confirms against source.
- **Staleness**: every finding is a hypothesis until reproduced on HEAD — prefer a
  micro-repro (a `node -e` running the real function) over re-reading. Self-reports
  are claims, not facts.

## Sources (fetched 2026-06-24, HTTP 200)
- Google Eng Practices: google.github.io/eng-practices — standard / looking-for /
  comments / pushback (raw on github.com/google/eng-practices).
- SmartBear "Best Practices for Peer Code Review" (Cisco study numbers).
- Microsoft code-with-engineering-playbook — code-reviews/process-guidance.
- Bacchelli & Bird, "Expectations, Outcomes, and Challenges of Modern Code Review,"
  ICSE 2013 (sback.it/publications/icse2013.pdf).
- Conventional Comments v1.0 — conventionalcomments.org.
- OWASP Code Review Guide v2 — github.com/OWASP/www-project-code-review-guide.
