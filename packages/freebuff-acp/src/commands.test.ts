import { describe, expect, it } from "vitest";

import {
  buildAvailableCommands,
  helpText,
  parseSlashCommand,
  skillCommandPrompt,
} from "./commands.js";

const skills = [{ name: "deploy", description: "Deploy the app" }];

describe("slash commands", () => {
  it("advertises built-ins plus one command per skill", () => {
    const names = buildAvailableCommands(skills).map((command) => command.name);
    expect(names).toEqual(["help", "status", "clear", "skills", "deploy"]);
  });

  it("parses built-ins, skill commands with args, and ignores everything else", () => {
    expect(parseSlashCommand("/clear", skills)).toEqual({ kind: "builtin", name: "clear", args: "" });
    expect(parseSlashCommand("/deploy to staging", skills)).toEqual({
      kind: "skill",
      name: "deploy",
      args: "to staging",
    });
    expect(parseSlashCommand("/unknown thing", skills)).toBeNull();
    expect(parseSlashCommand("plain prompt", skills)).toBeNull();
    expect(parseSlashCommand("look at /etc/hosts", skills)).toBeNull();
  });

  it("expands a skill command into a prompt naming the skill", () => {
    expect(skillCommandPrompt("deploy", "to staging")).toContain('"deploy"');
    expect(skillCommandPrompt("deploy", "to staging")).toContain("to staging");
    expect(helpText(skills)).toContain("/deploy — Deploy the app");
  });
});
