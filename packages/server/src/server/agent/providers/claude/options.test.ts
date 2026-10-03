import { describe, expect, it } from "vitest";

import { applyClaudeContextCap, type ClaudeProviderOptions } from "./options.js";

describe("applyClaudeContextCap", () => {
  it("emits the cap unchanged when it is inside the flag's accepted range", () => {
    const result = applyClaudeContextCap({}, 200_000);

    expect(result.extraArgs).toEqual({ autocompact: "200000" });
  });

  it("keeps a cap at the floor unchanged", () => {
    expect(applyClaudeContextCap({}, 100_000).extraArgs).toEqual({ autocompact: "100000" });
  });

  // Documented limitation: the CLI parser rejects anything under 100k, so a smaller user cap
  // cannot be represented on this harness and the window ends up higher than requested.
  it("raises a sub-floor cap to 100000 because the CLI cannot express it", () => {
    expect(applyClaudeContextCap({}, 50_000).extraArgs).toEqual({ autocompact: "100000" });
  });

  it("raises a cap one token below the floor to 100000", () => {
    expect(applyClaudeContextCap({}, 99_999).extraArgs).toEqual({ autocompact: "100000" });
  });

  it("emits no autocompact flag when no cap is configured", () => {
    const options: ClaudeProviderOptions = { disallowedTools: ["Bash"] };

    const result = applyClaudeContextCap(options, undefined);

    expect(result.extraArgs).toBeUndefined();
    expect(result.disallowedTools).toEqual(["Bash"]);
  });

  it("emits no autocompact flag for a cap above the flag's ceiling", () => {
    expect(applyClaudeContextCap({}, 2_000_000).extraArgs).toBeUndefined();
  });

  it("preserves user-supplied extraArgs while adding the derived cap", () => {
    const options: ClaudeProviderOptions = {
      extraArgs: { "dangerously-skip-permissions": null, "max-turns": "20" },
    };

    const result = applyClaudeContextCap(options, 200_000);

    expect(result.extraArgs).toEqual({
      "dangerously-skip-permissions": null,
      "max-turns": "20",
      autocompact: "200000",
    });
  });

  it("preserves the other provider option fields", () => {
    const options: ClaudeProviderOptions = { allowedTools: ["Read"] };

    expect(applyClaudeContextCap(options, 200_000)).toMatchObject({ allowedTools: ["Read"] });
  });

  // Explicit beats implicit: a hand-written --autocompact is a deliberate override of the
  // derived cap, including the valueless form the SDK would emit for a null value.
  it("does not overwrite a user-supplied autocompact", () => {
    const options: ClaudeProviderOptions = { extraArgs: { autocompact: "300000" } };

    expect(applyClaudeContextCap(options, 200_000).extraArgs).toEqual({ autocompact: "300000" });
  });

  it("does not overwrite a valueless user-supplied autocompact", () => {
    const options: ClaudeProviderOptions = { extraArgs: { autocompact: null } };

    expect(applyClaudeContextCap(options, 200_000).extraArgs).toEqual({ autocompact: null });
  });

  it("does not mutate the options it was given", () => {
    const options: ClaudeProviderOptions = { extraArgs: { "max-turns": "20" } };

    applyClaudeContextCap(options, 200_000);

    expect(options.extraArgs).toEqual({ "max-turns": "20" });
  });
});
