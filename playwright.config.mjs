import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', workers: 1, timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:3100', viewport: {width:1360,height:900}, launchOptions:{executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--disable-gpu']}, screenshot:'only-on-failure' },
  globalSetup:'./tests/browser/setup.mjs',
  reporter:'list'
});
