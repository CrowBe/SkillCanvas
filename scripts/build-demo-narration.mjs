import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const segments = [
  [1, "Skill Canvas makes invisible agent skills legible."],
  [5.6, "Load any skill; the workbench renders intent, anatomy, and lint."],
  [
    10.6,
    "A browser agent discovers twelve page-local WebMCP tools. This recording uses synthetic demo-agent evidence.",
  ],
  [
    16.8,
    "Open, read, update, and analyze shape the skill. Instruction-map submit records requirements.",
  ],
  [
    23.4,
    "Evaluation prepare and submit run triggering and mock checks. Compare and snapshot export preserve the result.",
  ],
  [
    31.2,
    "Snapshot import restores workspaces. Appearance read inspects the theme, and appearance set changes it.",
  ],
  [
    38.5,
    "The walkthrough demonstrates that grouped core workflow rather than showing every tool individually.",
  ],
  [
    44.2,
    "The site validates spans, grades deterministic facts, and checks every mock call against its contract.",
  ],
  [
    50.8,
    "In normal use, the visiting agent supplies the judgments and final JSON. Iterate on skills with your agent. Skill Canvas.",
  ],
];

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is required.");

const inputPath = "demo-output/skill-canvas-demo.webm";
const outputPath = "demo-output/skill-canvas-demo-narrated.mp4";
readFileSync(inputPath);
mkdirSync("demo-output/narration", { recursive: true });

const audioPaths = [];
for (const [index, [, text]] of segments.entries()) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.DEMO_TTS_MODEL ?? "gpt-4o-mini-tts",
      voice: process.env.DEMO_TTS_VOICE ?? "coral",
      input: text,
      instructions: "Clear, warm product-demo narration at a brisk pace.",
      response_format: "wav",
    }),
  });
  if (!response.ok) {
    throw new Error(
      `TTS segment ${index + 1} failed: ${await response.text()}`,
    );
  }
  const path = `demo-output/narration/${String(index + 1).padStart(2, "0")}.wav`;
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  audioPaths.push(path);
}

const delayed = segments.map(
  ([start], index) =>
    `[${index + 1}:a]adelay=${Math.round(start * 1000)}:all=1[a${index}]`,
);
const mixed = `${audioPaths.map((_, index) => `[a${index}]`).join("")}amix=inputs=${audioPaths.length}:duration=longest:normalize=0,apad[narration]`;
const ffmpeg = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-i",
    inputPath,
    ...audioPaths.flatMap((path) => ["-i", path]),
    "-filter_complex",
    [...delayed, mixed].join(";"),
    "-map",
    "0:v:0",
    "-map",
    "[narration]",
    "-c:v",
    "libopenh264",
    "-b:v",
    "2500k",
    "-c:a",
    "aac",
    "-shortest",
    outputPath,
  ],
  { stdio: "inherit" },
);
if (ffmpeg.error) throw ffmpeg.error;
if (ffmpeg.status !== 0) {
  throw new Error(`ffmpeg exited with status ${ffmpeg.status}.`);
}
console.log(`recorded ${outputPath}`);
