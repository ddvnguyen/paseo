import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { loadSkills } from "@codebuff/sdk";

/**
 * Slash commands the adapter exposes. Built-ins are handled locally (no model
 * call); every discovered skill (`~/.agents/skills`, `{cwd}/.agents/skills`)
 * becomes `/<skill-name> [request]` and expands to a prompt that tells the
 * agent to use that skill.
 */
export type BuiltinCommandName = "help" | "status" | "clear" | "skills";

const BUILTIN_COMMANDS: Array<AvailableCommand & { name: BuiltinCommandName }> = [
  { name: "help", description: "List the available slash commands" },
  { name: "status", description: "Show the current model, session and slot state" },
  { name: "clear", description: "Forget the conversation so far and start fresh" },
  { name: "skills", description: "List the skills available in this workspace" },
];

const BUILTIN_NAMES: ReadonlySet<string> = new Set(BUILTIN_COMMANDS.map((command) => command.name));

export interface SkillCommand {
  name: string;
  description: string;
}

/**
 * Discover skills for `cwd` plus `~/.agents/skills` and `~/.claude/skills`
 * (the SDK's standalone `loadSkills` skips the home directories unless asked,
 * which left agents started from a skill-less cwd with no skill commands).
 * Failures degrade to "no skill commands" but are logged, not swallowed.
 */
export async function discoverSkillCommands(cwd: string): Promise<SkillCommand[]> {
  try {
    const skills = await loadSkills({ cwd, includeHomeSkills: true });
    return Object.values(skills)
      .filter((skill) => typeof skill.name === "string" && !BUILTIN_NAMES.has(skill.name))
      .map((skill) => ({
        name: skill.name,
        description: (skill.description ?? "").trim() || `Use the ${skill.name} skill`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    process.stderr.write(
      `freebuff-acp: skill discovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return [];
  }
}

export function buildAvailableCommands(skills: SkillCommand[]): AvailableCommand[] {
  return [
    ...BUILTIN_COMMANDS,
    ...skills.map(
      (skill): AvailableCommand => ({
        name: skill.name,
        description: skill.description,
        input: { hint: "what you want done with this skill" },
      }),
    ),
  ];
}

export type ParsedCommand =
  | { kind: "builtin"; name: BuiltinCommandName; args: string }
  | { kind: "skill"; name: string; args: string };

/** Parse `/name args`; returns null for ordinary prompts and unknown commands. */
export function parseSlashCommand(text: string, skills: SkillCommand[]): ParsedCommand | null {
  const match = /^\/([A-Za-z0-9][\w.-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const name = match[1]!;
  const args = (match[2] ?? "").trim();
  if (BUILTIN_NAMES.has(name)) {
    return { kind: "builtin", name: name as BuiltinCommandName, args };
  }
  if (skills.some((skill) => skill.name === name)) {
    return { kind: "skill", name, args };
  }
  return null;
}

/** The prompt a skill command expands to. */
export function skillCommandPrompt(name: string, args: string): string {
  return args
    ? `Use the "${name}" skill (load it with the skill tool) for this request: ${args}`
    : `Use the "${name}" skill (load it with the skill tool) and follow its instructions.`;
}

export function helpText(skills: SkillCommand[]): string {
  const lines = ["Available commands:"];
  for (const command of buildAvailableCommands(skills)) {
    lines.push(`- /${command.name} — ${command.description}`);
  }
  return lines.join("\n");
}
