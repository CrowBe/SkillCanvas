import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { byteLength, err, ok, SKILL_MAX_BYTES, type Result } from "./shared";

export type SkillSource = {
  readonly frontmatter: {
    readonly name: string;
    readonly description: string;
    readonly extra: Readonly<Record<string, unknown>>;
  };
  readonly body: string;
};

export function parseSkillMd(rawInput: string): Result<SkillSource> {
  const raw = rawInput.replace(/\r\n/g, "\n");
  if (byteLength(raw) > SKILL_MAX_BYTES)
    return err("size_limit", `SKILL.md exceeds ${SKILL_MAX_BYTES} bytes.`);
  if (!raw.startsWith("---\n"))
    return err("invalid_skill", "SKILL.md must begin with YAML frontmatter.");
  const closing = raw.indexOf("\n---", 4);
  if (closing === -1)
    return err("invalid_skill", "SKILL.md frontmatter is not closed.");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw.slice(4, closing), { maxAliasCount: 0 });
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
    body: raw.slice(closing + 4).replace(/^\n+/, ""),
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
