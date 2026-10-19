import { readFileSync } from 'node:fs'

import type { BrowserContext } from '@playwright/test'

// What `pnpm verify:site-import` (infra/dev/site-import-verify) hands the browser half: a 0600
// file of its run directory whose path is the one variable of the run. Nothing here reads .env or
// starts a server: the stand runs next dev, core and every server the wizard connects to.

type BrowserCookie = Parameters<BrowserContext['addCookies']>[0][number]

interface Hosting {
  host: string
  ssh: number
  ftp: number
}

interface DatabaseAccess {
  host: string
  port: number
  database: string
  user: string
  password: string
}

export interface SiteImportStand {
  run: string
  origin: string
  outputDir: string
  reportFile: string
  /** b1 starts core itself, once its project waits: core is not running before. */
  holdCore: boolean
  /** The browser scenarios of the run (`b1`, `r4`, …). */
  browser: string[]
  control: { url: string; token: string }
  accounts: Record<string, { userId: string; cookies: BrowserCookie[] }>
  hostings: { site: Hosting; spare: Hosting }
  fingerprints: { first: string; second: string }
  roots: { site: string; empty: string; nestedParent: string; nested: string }
  users: {
    site: {
      user: string
      password: string
      privateKey: string
      keyWithPassphrase: { privateKey: string; passphrase: string }
    }
    ftpsite: { user: string; password: string }
    /** The account of r6 with the password it has on the hosting now. */
    siteb: { user: string; password: string }
  }
  databases: { mysql: DatabaseAccess; postgres: DatabaseAccess }
  /** Sites the stand made: r4 (its id from the request key), r6 (already failing). */
  sites: { r4?: string; r6?: string }
}

// eslint-disable-next-line turbo/no-undeclared-env-vars -- Set by the stand for this run only, outside Turbo tasks.
const standFile = process.env.SITE_IMPORT_STAND_FILE

/** null outside a run of the stand: the specs skip, so the smoke run never fails on them. */
export const stand: SiteImportStand | null = standFile
  ? (JSON.parse(readFileSync(standFile, 'utf8')) as SiteImportStand)
  : null

export function requireStand(): SiteImportStand {
  if (!stand) throw new Error('Run these tests through pnpm verify:site-import')
  return stand
}

/** The browser context signed in as the account of a scenario. */
export async function signIn(context: BrowserContext, account: string): Promise<void> {
  const cookies = requireStand().accounts[account]?.cookies
  if (!cookies) throw new Error(`The stand signed in no account ${account}`)
  await context.addCookies(cookies)
}

/** An action of the stand: start core, another host key of the spare hosting. */
export async function control(action: string): Promise<void> {
  const { url, token } = requireStand().control
  const response = await fetch(`${url}${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`The stand refused ${action} (HTTP ${response.status})`)
}

/** The address a project of a scenario is added with: unique per run, never dialed. */
export const projectUrl = (id: string) => `https://${id}-${requireStand().run}.stand.example.test`
