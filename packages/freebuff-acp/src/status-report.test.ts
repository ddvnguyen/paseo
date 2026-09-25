import { describe, expect, it } from "vitest";

import { FREEBUFF_AGENT_ID_BY_MODEL } from "./freebuff-agent.js";
import { checkModels } from "./status-report.js";

describe("checkModels", () => {
  it("reports server models the adapter lacks and adapter models the server dropped", () => {
    const known = Object.keys(FREEBUFF_AGENT_ID_BY_MODEL);
    const check = checkModels([...known.slice(1), "vendor/brand-new"]);
    expect(check).toEqual({
      checked: true,
      missingInAdapter: ["vendor/brand-new"],
      missingOnServer: [known[0]],
    });
  });

  it("does not claim a diff when the server was unreachable", () => {
    expect(checkModels(null)).toEqual({
      checked: false,
      missingInAdapter: [],
      missingOnServer: [],
    });
  });
});
