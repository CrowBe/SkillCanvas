import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  byteLength,
  err,
  isJsonObject,
  normalizeReferencePath,
  ok,
  REFERENCE_MAX_BYTES,
  REFERENCES_MAX,
  SKILL_MAX_BYTES,
  type Result,
} from "./shared";

export type SkillSource = {
  readonly frontmatter: {
    readonly name: string;
    readonly description: string;
    readonly extra: Readonly<Record<string, unknown>>;
  };
  readonly body: string;
};

export type SkillFrontmatterBounds = {
  readonly yamlStart: number;
  readonly yamlEnd: number;
  readonly bodyStart: number;
};

export function skillFrontmatterBounds(
  raw: string,
): SkillFrontmatterBounds | null {
  const opening = /^---\r?\n/.exec(raw);
  if (!opening) return null;
  const closing = /\r?\n---(?:\r?\n|$)/g.exec(raw.slice(opening[0].length));
  if (!closing) return null;
  const yamlEnd = opening[0].length + closing.index;
  const delimiterEnd = yamlEnd + closing[0].length;
  const leadingNewlines =
    raw.slice(delimiterEnd).match(/^(?:\r?\n)+/)?.[0].length ?? 0;
  return {
    yamlStart: opening[0].length,
    yamlEnd,
    bodyStart: delimiterEnd + leadingNewlines,
  };
}

export function parseSkillMd(rawInput: string): Result<SkillSource> {
  if (byteLength(rawInput) > SKILL_MAX_BYTES)
    return err("size_limit", `SKILL.md exceeds ${SKILL_MAX_BYTES} bytes.`);
  const raw = rawInput.replace(/\r\n/g, "\n");
  const bounds = skillFrontmatterBounds(raw);
  if (!raw.startsWith("---\n"))
    return err("invalid_skill", "SKILL.md must begin with YAML frontmatter.");
  if (!bounds)
    return err("invalid_skill", "SKILL.md frontmatter is not closed.");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw.slice(bounds.yamlStart, bounds.yamlEnd), {
      maxAliasCount: 0,
    });
  } catch {
    return err("invalid_skill", "Could not parse frontmatter YAML.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return err("invalid_skill", "Frontmatter must be a YAML mapping.");
  }
  const { name, description, ...extra } = parsed as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "")
    return err("invalid_skill", "Frontmatter requires a name.");
  if (typeof description !== "string" || description.trim() === "")
    return err("invalid_skill", "Frontmatter requires a description.");
  const json = JSON.stringify(extra);
  if (json === undefined || byteLength(json) > 32 * 1024)
    return err("size_limit", "Extra frontmatter is too large.");
  return ok({
    frontmatter: { name, description, extra },
    body: raw.slice(bounds.bodyStart),
  });
}

export function serializeSkillMd(source: SkillSource): string {
  const yaml = stringifyYaml({
    name: source.frontmatter.name,
    description: source.frontmatter.description,
    ...source.frontmatter.extra,
  }).trimEnd();
  return `---\n${yaml}\n---\n\n${source.body}`;
}

export const EMPTY_SKILL = `---
name: untitled-skill
description: Describe when the visiting agent should use this skill.
---

# Untitled skill

Describe the workflow and constraints here.
`;

/**
 * The rule for admissible Skill content: a parseable SKILL.md plus reference
 * files with canonical, unique, in-budget paths. Returns the normalized files
 * in the order they were supplied, so callers can detect noncanonical input by
 * comparing positions.
 */
export function validateSkillInput(
  skillMd: unknown,
  files: unknown,
): Result<readonly { path: string; content: string }[]> {
  if (typeof skillMd !== "string")
    return err("invalid_submission", "SKILL.md content must be a string.");
  if (!Array.isArray(files))
    return err("invalid_submission", "Reference files must be an array.");
  const parsed = parseSkillMd(skillMd);
  if (!parsed.ok) return parsed;
  if (files.length > REFERENCES_MAX)
    return err(
      "size_limit",
      `A Skill may include at most ${REFERENCES_MAX} reference files.`,
    );
  const normalized: { path: string; content: string }[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (
      !isJsonObject(file) ||
      typeof file.path !== "string" ||
      typeof file.content !== "string"
    )
      return err(
        "invalid_submission",
        "Each reference file requires string path and content fields.",
      );
    const path = normalizeReferencePath(file.path);
    if (!path.ok) return path;
    if (seen.has(path.value.toLowerCase()))
      return err("duplicate_path", `Duplicate normalized path: ${path.value}`);
    if (byteLength(file.content) > REFERENCE_MAX_BYTES)
      return err("size_limit", `Reference file ${path.value} is too large.`);
    seen.add(path.value.toLowerCase());
    normalized.push({ path: path.value, content: file.content });
  }
  return ok(normalized);
}
