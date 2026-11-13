import { defineConfig } from '@playwright/test'

// The isolation of the agent's pages in a real browser (docs/plan/67-agent-documents.md, Д3): the
// test serves its own two hosts, so neither web nor a database is needed.
export default defineConfig({
  testDir: './tests/documents',
  timeout: 30_000,
  reporter: 'list',
})
