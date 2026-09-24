import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './browser-tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'line',
  use: {
    baseURL:
      process.env.BIPLAN_BROWSER_ORIGIN ||
      (process.env.BIPLAN_BROWSER_START === '1'
        ? 'http://127.0.0.1:4173'
        : 'http://127.0.0.1:3001'),
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  ...(process.env.BIPLAN_BROWSER_START === '1'
    ? {
        webServer: {
          command: 'node scripts/browser-preview.mjs',
          url: 'http://127.0.0.1:4173',
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }
    : {}),
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-375',
      use: {
        browserName: 'chromium',
        viewport: { width: 375, height: 812 },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
