import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://localhost:4321",
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: "pnpm preview --port 4321",
    url: "http://localhost:4321",
    reuseExistingServer: !process.env.CI,
  },
});
