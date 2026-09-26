import { loadSkills } from "@codebuff/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAvailableCommands,
  discoverSkillCommands,
  helpText,
  parseSlashCommand,
  skillCommandPrompt,
} from "./commands.js";

vi.mock("@codebuff/sdk", () => ({ loadSkills: vi.fn() }));

const skills = [{ name: "deploy", description: "Deploy the app" }];

describe("slash commands", () => {
  it("advertises built-ins plus one command per skill", () => {
    const names = buildAvailableCommands(skills).map((command) => command.name);
    expect(names).toEqual(["help", "status", "clear", "skills", "deploy"]);
  });

  it("parses built-ins, skill commands with args, and ignores everything else", () => {
    expect(parseSlashCommand("/clear", skills)).toEqual({
      kind: "builtin",
      name: "clear",
      args: "",
    });
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

describe("discoverSkillCommands", () => {
  afterEach(() => {
    vi.mocked(loadSkills).mockReset();
    vi.restoreAllMocks();
  });

  // The fork SDK's standalone loadSkills defaults includeHomeSkills to false, so
  // agents started from a cwd without project skills got no skill commands.
  it("asks the SDK for home skills as well as the cwd's", async () => {
    vi.mocked(loadSkills).mockResolvedValue({
      "home-skill": { name: "home-skill", description: "From home" },
    } as never);

    const found = await discoverSkillCommands("/tmp/fbcwd");

    expect(loadSkills).toHaveBeenCalledWith({ cwd: "/tmp/fbcwd", includeHomeSkills: true });
    expect(found).toEqual([{ name: "home-skill", description: "From home" }]);
  });

  it("logs a discovery failure instead of swallowing it", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.mocked(loadSkills).mockRejectedValue(new Error("boom"));

    expect(await discoverSkillCommands("/tmp/fbcwd")).toEqual([]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("skill discovery failed: boom"));
  });
});
