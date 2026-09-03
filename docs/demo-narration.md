# Demo narration script

Voiceover for `skill-canvas-demo-narrated.mp4` (recorded by
`scripts/record-demo.mjs`, ~47 s). Segments were generated with OpenAI TTS and
placed at the listed offsets with ffmpeg. Keep copy short: nine segments must
fit the video with no overlap.

| #   | Start (s) | Copy                                                                                                      |
| --- | --------- | --------------------------------------------------------------------------------------------------------- |
| 1   | 1.0       | Skill Canvas makes invisible agent skills legible.                                                        |
| 2   | 5.6       | Load any skill; the workbench renders intent, anatomy, and lint.                                          |
| 3   | 10.6      | Then your agent authors a new skill, live, through WebMCP tools.                                          |
| 4   | 15.2      | The site grades the deterministic facts.                                                                  |
| 5   | 18.1      | Your agent proposes an instruction map — the site validates every span and dependency.                    |
| 6   | 23.5      | Evaluations split the same way: your agent answers; the site grades.                                      |
| 7   | 28.2      | A mocked test run checks every call against its contract.                                                 |
| 8   | 32.1      | Revise, compare, export evidence-free.                                                                    |
| 9   | 36.6      | The same agent seam even picks your theme, and says why. Iterate on skills with your agent. Skill Canvas. |

Re-record flow: `node scripts/record-demo.mjs`, then regenerate the nine
segments with the TTS tool (OpenAI, default voice), atempo 1.09 each, place at
the offsets above with `adelay` + `amix`, mux with
`ffmpeg -i skill-canvas-demo.webm -i narration-track.mp3 -c:v libopenh264
-b:v 2500k -c:a aac` (no libx264 in this ffmpeg build).
