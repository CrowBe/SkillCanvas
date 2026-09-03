# Agent collaboration model

Skill Canvas uses WebMCP in two registers. Every tool belongs to one of them,
and the split is deliberate: it is the product thesis, not an implementation
accident.

## Register 1 — tool calls (deterministic work)

The site supplies ground truth. These tools do work a script could do, and
that is the point: the human gets unmodelled, reproducible facts about their
Skill — lint grades, structural anatomy, dependency load, revision diffs,
content hashes. Nothing here asks the agent for an opinion.

| Tool                                    | Deterministic contribution                                                  |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `skill_open` / `skill_read`             | Bounded, content-addressed Skill state; SHA-256-identified revisions        |
| `skill_analyze`                         | Lint and structure artifacts pinned to revision and hash, versioned ruleset |
| `skill_compare`                         | Traceable line-oriented diff plus before/after lint grades                  |
| `skill_update`                          | Append-only revisioning with `baseRevision` conflict detection              |
| `workspace_snapshot_export` / `_import` | Evidence-free portability with strict admission                             |
| `appearance_read`                       | Current preference state                                                    |

## Register 2 — inference as a participant

The agent supplies judgment the site cannot compute. These calls have no
meaningful answer without a model, and the site treats what comes back as
**Evidence** — labelled agent-supplied, graded separately from deterministic
analysis, never crossing a snapshot import.

| Tool                                                    | Agent-supplied contribution                                                                        | Site's deterministic half                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `skill_open` (authoring)                                | The Skill's actual text — the agent is the Skill author                                            | Bounded parsing, unknown-frontmatter preservation, revision append                                |
| `instruction_map_submit`                                | Decomposition of the Skill into atomic requirements with source spans, kinds, scopes, dependencies | Span/dependency/cycle validation, persisted map, instruction-load vector                          |
| `evaluation_prepare` / `evaluation_submit` (triggering) | Per-case trigger choices **with rationales**                                                       | Fire/silent grading against the versioned prompt battery and distractor library                   |
| `evaluation_prepare` (test-run) + mock invocation       | Driving the mock world, final output                                                               | Contract checks, transcript capture, schema validation of arguments and output                    |
| `appearance_set`                                        | A theme choice **with a stated rationale**                                                         | Applying a visible browser preference; excluded from revisioning, hashes, evidence, and snapshots |

The collaboration loop is the product: _iterate on your Skill with your
agent_ — the human reads the deterministic ground truth, the agent proposes
the next move, the site validates and grades it, both sides can see what the
other contributed.

## The appearance Easter egg — a deliberate first step

`appearance_set` accepting an agent-chosen theme looks like a gimmick. It is
not: it is the same seam as Skill authoring, pointed at the environment. The
agent that can edit your Skill can also tune the workspace you both share,
and it explains itself when it does.

The future this points at: an agent that knows you work in Terminal by day
and Cardigan when reviewing prose, and adapts the site on the fly — because
the mechanism is identical to every other agent-supplied judgment in this
workbench. The boundary stays honest by design: the choice is a browser
preference, its rationale is shown in the UI, and neither becomes Skill
content, evidence, or snapshot payload.

## Rules this model commits to

- Every agent-supplied artifact is labelled (`visiting-agent proposal`,
  `visiting browser agent`) and graded separately from deterministic
  analysis.
- Nothing agent-supplied crosses a snapshot import; deterministic results
  are regenerated locally.
- The agent never executes Skill content, and the site never performs
  semantic judgment itself — not even theme taste is pretended to be
  deterministic.
