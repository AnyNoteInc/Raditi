import { readAppVersion } from '@repo/app-bootstrap'

// src/version.ts and dist/version.js sit at the same depth, so the path works for both.
export const MCP_VERSION: string = readAppVersion(new URL('../package.json', import.meta.url))
