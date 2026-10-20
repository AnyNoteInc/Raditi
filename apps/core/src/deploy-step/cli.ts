import { appendFileSync } from 'node:fs'
import process from 'node:process'

import {
  isProduction,
  normalizeSiteHost,
  resolvePinnedAddress,
  type DeployAccess,
  type DeployManifest,
  type HostingSession,
} from '@repo/domain'
import { getSiteContentAdapter } from '@repo/site-adapters'
import {
  createHostLookup,
  createPinnedSiteTransport,
  hostingWriterOf,
} from '@repo/site-connections/hosting'
import { createVaultSecretStore } from '@repo/vault'

import { deployStepCommand, type DeployInput } from './command.ts'
import { runDeploy, type DeployResult } from './deploy.ts'
import { deployKeyOf } from './envelope.ts'
import { createReleaseApi, presignedTransfer, waitForReleaseApi } from './release-api.ts'
import { checkSite } from './site-check.ts'
import { createTreeSource } from './tree-source.ts'

// `node /app/apps/core/dist/deploy-step/cli.js match|run` — the steps of the obligatory
// deploy workflow of a site (ci/.gitea/scoped_workflows/deploy.yml, plan 53 Р28–Р31). The
// commands are command.ts; this file gives them the real world: the runner's Vault, the release
// API of core, the hosting over SFTP or FTP(S), the site's plugin and the site itself, each
// reached only at an address the site-address rule allows.

/** What a presigned PUT of the backup may answer. */
const UPLOAD_ANSWER_BYTES = 64 * 1024

async function deploy(input: DeployInput): Promise<DeployResult> {
  const { machine, wrap, run, data, jobToken } = input
  const backupKey = deployKeyOf(data.backupKey)
  const lookup = createHostLookup()
  const appEnv = machine.appEnv
  const transport = createPinnedSiteTransport({ lookup, appEnv })
  const cancel = new AbortController()
  const stop = () => cancel.abort()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  // The bounds of every request are timers that do not hold the process; this one does, so a
  // request nothing answers ends in its own timeout and the rollback, never in a silent exit.
  const alive = setInterval(() => {}, 60_000)

  // The deploy decides how long a session lives (deploy.ts): the forward one ends with a cancel
  // of the job, each of the rollback with the rollback's deadline.
  const openHosting = async (
    hosting: DeployAccess['hosting'],
    signal: AbortSignal,
  ): Promise<HostingSession> => {
    const writer = hostingWriterOf(hosting.method)
    if (!writer) throw new Error('No writer of this method')
    const access = writer.accessSchema.parse(hosting.access)
    const host = normalizeSiteHost(writer.endpointOf(access).host)
    if (host === null) throw new Error('Hosting address refused')
    const pinned = await resolvePinnedAddress({ lookup, appEnv }, host, signal)
    if (!pinned.ok) throw new Error('Hosting address refused')
    return writer.open(access, { address: pinned.address, signal })
  }
  const connectionOf = (
    content: NonNullable<DeployAccess['content']>,
    manifest: DeployManifest,
  ) => {
    const adapter = getSiteContentAdapter(content.stack)
    const access = adapter.accessSchema.parse(content.access)
    // The access was issued for the site's own address; any other origin is refused.
    if (access.origin !== manifest.verify.origin)
      throw new Error('Content access of another origin')
    const connection = {
      siteId: manifest.siteId,
      origin: access.origin,
      access,
      transport,
      allowLoopbackHttp: !isProduction(appEnv),
    }
    return { adapter, connection }
  }
  const contentGateway = (
    content: NonNullable<DeployAccess['content']>,
    manifest: DeployManifest,
  ) => {
    const { adapter, connection } = connectionOf(content, manifest)
    return adapter.createGateway(connection)
  }
  // The code cache of the site's PHP through the same plugin (stand R12).
  const codeCache = (content: NonNullable<DeployAccess['content']>, manifest: DeployManifest) => {
    const { adapter, connection } = connectionOf(content, manifest)
    if (!adapter.createCodeCache) throw new Error('No code cache of this stack')
    return adapter.createCodeCache(connection)
  }

  try {
    return await runDeploy({
      wrap,
      api: createReleaseApi({
        baseUrl: machine.releaseApiUrl,
        releaseId: wrap.releaseId,
        deployAttempt: wrap.attempt,
        token: data.releaseApiToken,
      }),
      backupKey,
      tree: createTreeSource({ run, token: jobToken }),
      openHosting,
      contentGateway,
      codeCache,
      download: (presigned, maxBytes) => presignedTransfer(presigned, { maxBytes }),
      upload: async (presigned, body) => {
        await presignedTransfer(presigned, { body, maxBytes: UPLOAD_ANSWER_BYTES })
      },
      checkSite: (verify) => checkSite(transport, verify),
      log: (line) => process.stdout.write(`${line}\n`),
      signal: cancel.signal,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
  } finally {
    clearInterval(alive)
    backupKey.fill(0)
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
}

process.exitCode = await deployStepCommand(process.argv.slice(2), {
  env: process.env,
  print: (line) => process.stdout.write(`${line}\n`),
  setOutput(name, value) {
    // The file of the step's outputs, named by the runner (act names it GITHUB_OUTPUT).
    const runner: Record<string, string | undefined> = process.env
    const file = runner.GITHUB_OUTPUT ?? runner.GITEA_OUTPUT
    if (file) appendFileSync(file, `${name}=${value}\n`)
  },
  reachable: (releaseApiUrl) => waitForReleaseApi(releaseApiUrl),
  unwrap: (addr, token) => createVaultSecretStore({ addr }).unwrap(token),
  deploy,
})
