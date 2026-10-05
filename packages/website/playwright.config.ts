import { defineConfig, devices } from "playwright/test";

const baseURL = process.env.WEBSITE_TEST_URL ?? "http://127.0.0.1:8187";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: { baseURL, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: process.env.WEBSITE_TEST_URL
    ? undefined
    : {
        command: "npm run build && npm run preview -- --host 127.0.0.1 --port 8187 --strictPort",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        // Playwright's 60s default assumes an idle machine. This job installs
        // browsers and system packages first, and the command above runs a full
        // production build before preview, so a cold start does not fit 60s and
        // fails the whole typecheck job on "Timed out waiting ... from
        // config.webServer" with no other signal.
        timeout: 180_000,
      },
});
