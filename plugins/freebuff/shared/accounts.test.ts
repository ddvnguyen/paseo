import { describe, expect, it } from "vitest";

import { freebuffAccountsList } from "./accounts.js";

const accountDetail = freebuffAccountsList.output.shape.accounts.element;

describe("accountDetail", () => {
  it("passes the adapter's optional email/name through", () => {
    const parsed = accountDetail.parse({
      id: "work",
      label: "Work",
      isDefault: false,
      authenticated: true,
      managed: true,
      email: "duc@x.y",
      name: "Duc",
      seat: { state: "none" },
      status: null,
      cliSettings: null,
    });
    expect(parsed.email).toBe("duc@x.y");
    expect(parsed.name).toBe("Duc");
  });

  it("omits email/name when the adapter knows no login identity", () => {
    const parsed = accountDetail.parse({
      id: "default",
      label: "Freebuff account",
      isDefault: true,
      authenticated: false,
      managed: false,
      seat: { state: "none" },
      status: null,
      cliSettings: null,
    });
    expect(parsed).not.toHaveProperty("email");
    expect(parsed).not.toHaveProperty("name");
  });
});
