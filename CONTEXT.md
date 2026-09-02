# Skill Canvas domain model

The terms this codebase commits to. Use them exactly; if a name here and a name in
the code disagree, one of them is wrong and it is worth saying which.

## Skill content

**Skill** — the artefact under study: one `SKILL.md` plus its reference files. Imported
Skill content is data only. It is bounded, path-normalized, content-addressed, and
never executed.

**Reference** — a bounded file accompanying a Skill, addressed by a normalized relative
path. Never absolute, never traversing, never `SKILL.md`.

**Revision** — an immutable numbered version of a Skill's content within a Workspace.
Revisions form a linear lineage from 1; the **tip** is the highest-numbered revision and
must equal the Workspace's current revision. Nothing is ever overwritten: reversal means
appending a later Revision.

**Blob** — immutable Skill or reference content, addressed by byte-exact SHA-256.
Line endings are part of the identity; nothing is normalized.

**Workspace** — one Skill under study, with its Revisions, Artifacts, Evaluations, and
audit events.

## Analysis and evidence

**Artifact** — a deterministic, traceable record computed from one Revision: `lint`,
`structure`, `instruction-map`, `instruction-load`, or `compare`. Every Artifact is
pinned to a Revision and a content hash, and carries the ruleset version that produced it.

**Provenance** — where an Artifact's data came from, which decides whether an imported
copy can be trusted. Exactly three: **derived** (recomputable from the Revision, so an
import must match the canonical recomputation byte for byte), **supplied** (offered by a
visiting agent, checked for shape only), and **evidence** (an observation that cannot be
recomputed, so it never crosses an import). Each Artifact kind declares one.

**Instruction map** — a visiting-agent proposal decomposing a Skill into atomic
requirements with exact Source-spans, scopes, and dependency references. It stays labelled
a proposal; acceptance is an explicit action. Browser code validates it; it never authors it.

**Instruction load vector** — the multidimensional load metrics derived from an accepted
Instruction map. Never a single score, and never inferred from tokens or bullets.

**Evidence** — anything a visiting agent supplied or a run observed: trigger choices,
rationales, mock transcripts, final outputs, comparison results. Evidence is
distinguished from deterministic analysis at every layer, and it does not travel.

**Evaluation** — a prepared, versioned protocol run (`triggering` or `test-run`) that
collects Evidence for one Revision. Nothing imported or real is ever executed.

**Workspace view** — the already-selected projection of a Workspace for display: the
current lint, structure, Instruction map, Instruction load vector, latest comparison, and
newest Evaluation, with that Evaluation's kind resolved and its next unanswered case
picked. Always derived, never stored: browser code renders the view and never re-derives
the selection rules for itself.

## Snapshots

**Workbench snapshot** — the portable JSON export of a Workspace: Skill content,
references, Revisions, accepted maps, and audit events.

**Evidence-free** — the admissibility rule for a Workbench snapshot. Exports omit
Evaluations and comparisons; imports reject any snapshot carrying them. Deterministic
results are regenerated locally after import.

**Admission** — deciding whether untrusted JSON is an acceptable Workbench snapshot.
Two distinct questions, deliberately kept apart:

- _Is this a well-formed, self-consistent, evidence-free snapshot?_ — a property of the
  snapshot alone. Owned by one module.
- _Can it land here?_ — a property of the store: id collisions, and whether a confirmed
  **Replacement target** is still current.

**Admitted snapshot** — a snapshot that has passed the first question. The type carries
the proof, so a store cannot be reached with unchecked content.

**Replacement target** — the saved Workspace a user confirmed for replacement, captured
with its **Generation**. If either changed since confirmation, the replacement is refused
rather than applied.

**Generation** — a per-Workspace counter that makes concurrent writes detectable. It is
persistence mechanism, not Skill content: it never affects a content hash, a Revision, or
a snapshot.

## Appearance

**Appearance** — a visible browser preference (`system`, `light`, `dark`, `tuxedo`,
`cardigan`, `terminal`). It is not Workspace content: excluded from revisioning, hashes,
Evidence, and snapshots.

## Not in this vocabulary

Accounts, teams, publishing, provider keys, a model gateway, remote persistence, and
whole-agent configuration are out of scope. There is no single "Skill quality score":
the workbench offers several angles on the same Skill and refuses to collapse them.
