import { resolveCredentials } from "../src/auth.js";

const credentials = resolveCredentials();
if (!credentials) {
  console.error("SKIP: no credentials");
  process.exit(2);
}
const H = { Authorization: `Bearer ${credentials.apiKey}` };

// 1. Plain session GET (the poll endpoint the CLI uses)
const get = await fetch("https://codebuff.com/api/v1/freebuff/session", { headers: H });
console.log("GET session:", get.status, (await get.text()).slice(0, 300));

// 2. Admission POST with full header set
const adm = await fetch("https://codebuff.com/api/v1/freebuff/session/admission", {
  method: "POST",
  headers: {
    ...H,
    "x-freebuff-model": "z-ai/glm-5.3-flash",
    "x-freebuff-first-tab-discount": "0",
    "x-freebuff-wallet-spend-limit": "0",
    "x-fb-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  },
});
console.log("POST admission:", adm.status, (await adm.text()).slice(0, 400));
