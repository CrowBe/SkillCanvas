import { defineConfig, devices } from "@playwright/test";

const webmcpEval = process.env.WEBMCP_EVAL === "1";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // WebMCP evals need a WebMCP-enabled Chromium; the default lane stays on
    // plain chromium. Run with:
    //   WEBMCP_EVAL=1 npx playwright test --project=webmcp-chromium
    ...(webmcpEval
      ? [
          {
            name: "webmcp",
            use: {
              ...devices["Desktop Chrome"],
              launchOptions: {
                args: [
                  "--enable-features=WebMCP",
                  "--enable-blink-features=WebMCP",
                ],
              },
            },
          },
        ]
      : []),
  ],
});
