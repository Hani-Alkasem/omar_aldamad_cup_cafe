import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173', browserName: 'chromium' },
  webServer: {
    command: 'npx http-server dist -p 4173 -s -c-1',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: true,
  },
});
