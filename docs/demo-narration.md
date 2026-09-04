# Demo narration script

Voiceover for `demo-output/skill-canvas-demo-narrated.mp4` (about one minute).
The deterministic recording labels its hard-coded trigger choices and final
JSON as synthetic demo-agent evidence; a normal interactive run receives those
judgments from the visiting browser agent.

| #   | Start (s) | Copy                                                                                                                      |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | 1.0       | Skill Canvas makes invisible agent skills legible.                                                                        |
| 2   | 5.6       | Load any skill; the workbench renders intent, anatomy, and lint.                                                          |
| 3   | 10.6      | A browser agent discovers twelve page-local WebMCP tools. This recording uses synthetic demo-agent evidence.              |
| 4   | 16.8      | Open, read, update, and analyze shape the skill. Instruction-map submit records requirements.                             |
| 5   | 23.4      | Evaluation prepare and submit run triggering and mock checks. Compare and snapshot export preserve the result.            |
| 6   | 31.2      | Snapshot import restores workspaces. Appearance read inspects the theme, and appearance set changes it.                   |
| 7   | 38.5      | The walkthrough demonstrates that grouped core workflow rather than showing every tool individually.                      |
| 8   | 44.2      | The site validates spans, grades deterministic facts, and checks every mock call against its contract.                    |
| 9   | 50.8      | In normal use, the visiting agent supplies the judgments and final JSON. Iterate on skills with your agent. Skill Canvas. |

From the repository root, record and build the synchronized, music-free MP4:

```bash
node scripts/record-demo.mjs
OPENAI_API_KEY=... node scripts/build-demo-narration.mjs
```

The second command generates the nine speech segments at the offsets above and
muxes them with the deterministic input video. Its explicit output is
`demo-output/skill-canvas-demo-narrated.mp4`.
