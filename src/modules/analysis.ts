import { RULESET_VERSION, type SourceSpan } from "./shared";
import { parseSkillMd, type SkillSource } from "./skill";

export type LintSeverity = "error" | "warn" | "info";
export type LintFinding = {
  readonly rule: string;
  readonly severity: LintSeverity;
  readonly message: string;
  readonly sourceSpan?: SourceSpan;
};
export type LintArtifact = {
  readonly kind: "lint";
  readonly rulesetVersion: typeof RULESET_VERSION;
  readonly score: number;
  readonly grade: "A" | "B" | "C" | "D";
  readonly counts: Readonly<Record<LintSeverity, number>>;
  readonly findings: readonly LintFinding[];
};
export type StructureArtifact = {
  readonly kind: "structure";
  readonly rulesetVersion: typeof RULESET_VERSION;
  readonly title: string;
  readonly description: string;
  readonly sections: readonly {
    readonly level: number;
    readonly title: string;
    readonly sourceSpan: SourceSpan;
  }[];
};

const RULES: readonly {
  id: string;
  severity: LintSeverity;
  message: string;
  pattern: RegExp;
}[] = [
  {
    id: "policy.fetch-and-follow",
    severity: "error",
    message:
      "Remote instructions must remain inspectable; do not fetch and follow them.",
    pattern:
      /(?:fetch|download).{0,100}https?:\/\/.{0,140}(?:follow|obey|execute).{0,50}instructions?/is,
  },
  {
    id: "policy.shell-exec",
    severity: "warn",
    message: "The skill asks the host agent to execute shell commands.",
    pattern:
      /(?:run|execute).{0,80}(?:shell|terminal|bash|powershell|`(?:sudo|npm|curl|wget))/is,
  },
  {
    id: "policy.credential-path",
    severity: "warn",
    message: "The skill references a credential or secret location.",
    pattern:
      /(?:\.env|\.ssh\/|\.aws\/credentials|api[_ -]?key|access[_ -]?token)/i,
  },
  {
    id: "policy.obfuscation",
    severity: "warn",
    message:
      "Keep instructions readable instead of relying on encoded payloads.",
    pattern:
      /(?:base64|rot13|obfuscated payload).{0,100}(?:decode|execute|follow)/is,
  },
] as const;

function spanOf(raw: string, needle: string): SourceSpan | undefined {
  const start = raw.indexOf(needle);
  return start < 0 ? undefined : { start, end: start + needle.length };
}

export function analyzeLint(
  raw: string,
  referencePaths: readonly string[] = [],
): LintArtifact {
  const findings: LintFinding[] = [];
  const parsed = parseSkillMd(raw);
  if (!parsed.ok) {
    findings.push({
      rule: "skill.parse",
      severity: "error",
      message: parsed.error.message,
    });
  } else {
    const { name, description, extra } = parsed.value.frontmatter;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
      findings.push({
        rule: "frontmatter.name-format",
        severity: "error",
        message: "Name must use lowercase kebab-case.",
        sourceSpan: spanOf(raw, name),
      });
    if (description.length < 12)
      findings.push({
        rule: "frontmatter.description-short",
        severity: "warn",
        message: "Description is too short to support reliable triggering.",
        sourceSpan: spanOf(raw, description),
      });
    if (
      !/\b(?:use|when|create|review|analy[sz]e|build|debug|edit|generate|test)\b/i.test(
        description,
      )
    )
      findings.push({
        rule: "frontmatter.description-trigger",
        severity: "info",
        message:
          "Description should say what request should trigger the Skill.",
        sourceSpan: spanOf(raw, description),
      });
    for (const key of Object.keys(extra).sort())
      findings.push({
        rule: "frontmatter.unknown-key",
        severity: "info",
        message: `Unknown frontmatter key \`${key}\` is preserved.`,
        sourceSpan: spanOf(raw, `${key}:`),
      });
    if (parsed.value.body.trim().length < 40)
      findings.push({
        rule: "body.too-short",
        severity: "warn",
        message: "Add enough workflow detail for an agent to act consistently.",
        sourceSpan: spanOf(raw, parsed.value.body.trim()),
      });
    if (!/^#{1,3}\s+.+$/m.test(parsed.value.body))
      findings.push({
        rule: "body.structure",
        severity: "info",
        message: "Add headings to make the Skill easier to scan.",
      });
    for (const match of parsed.value.body.matchAll(
      /\[[^\]]+\]\(([^)\s]+)\)/g,
    )) {
      const target = match[1];
      if (
        target &&
        !/^(?:https?:|#)/.test(target) &&
        !referencePaths.includes(target.replace(/^\.\//, ""))
      ) {
        findings.push({
          rule: "body.reference-file.missing",
          severity: "info",
          message: `Local reference \`${target}\` is missing.`,
          sourceSpan: spanOf(raw, target),
        });
      }
    }
  }
  for (const rule of RULES) {
    const match = raw.match(rule.pattern);
    if (match?.[0])
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        message: rule.message,
        sourceSpan: spanOf(raw, match[0]),
      });
  }
  const counts = { error: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const score = Math.max(
    0,
    100 - counts.error * 30 - counts.warn * 12 - counts.info * 3,
  );
  const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : "D";
  return {
    kind: "lint",
    rulesetVersion: RULESET_VERSION,
    score,
    grade,
    counts,
    findings,
  };
}

export function analyzeStructure(raw: string): StructureArtifact {
  const parsed = parseSkillMd(raw);
  const source: SkillSource = parsed.ok
    ? parsed.value
    : {
        frontmatter: {
          name: "Invalid skill",
          description: parsed.error.message,
          extra: {},
        },
        body: raw,
      };
  const sections: Array<{
    level: number;
    title: string;
    sourceSpan: SourceSpan;
  }> = [];
  for (const match of raw.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
    if (match.index === undefined || !match[1] || !match[2]) continue;
    sections.push({
      level: match[1].length,
      title: match[2].trim(),
      sourceSpan: { start: match.index, end: match.index + match[0].length },
    });
  }
  return {
    kind: "structure",
    rulesetVersion: RULESET_VERSION,
    title: source.frontmatter.name,
    description: source.frontmatter.description,
    sections,
  };
}
