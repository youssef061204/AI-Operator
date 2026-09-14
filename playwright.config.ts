import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  timeout: 45000,
  workers: 1,
  fullyParallel: false,
  reporter: [
    ["list"],
    ["json", { outputFile: "artifacts/verification/browser.json" }],
  ],
  outputDir: "artifacts/verification/browser-output",
  use: {
    baseURL: "http://localhost:3010",
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command:
        "pnpm --filter @operator-assist/agent exec tsx tests/browser-fixture.ts",
      url: "http://127.0.0.1:7788/health",
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: "pnpm --filter @operator-assist/web exec next dev -p 3010",
      url: "http://localhost:3010",
      env: { NEXT_DIST_DIR: ".next-e2e" },
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
});
