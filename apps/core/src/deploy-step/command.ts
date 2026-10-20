import {
  deployWrapDataMatches,
  deployWrapDataSchema,
  type DeployWrap,
  type DeployWrapData,
} from '@repo/domain'

import type { DeployOutcome, DeployResult } from './deploy.ts'
import {
  machineFactsFrom,
  matchRun,
  runFactsFrom,
  runServerAllowed,
  type MachineFacts,
  type RunFacts,
  type RunMatch,
} from './run-facts.ts'

// The two commands of `deploy-step` (cli.ts), with the world injected:
//
//   match  — is the secret RADITI_DEPLOY_WRAP for this run (its tag and commit)? Prints the run
//            and writes `matched=true|false` to the step outputs. Spends nothing.
//   run    — the same check again; waits for the release API of core to answer its health check
//            (the wrapping is single-use: it is not spent while core cannot take the attempt); only
//            then unwraps the secret at the runner's Vault, checks that the wrapping is of the
//            release and attempt the secret names, and deploys through the release API (deploy.ts).
//            The exit code is 0 only for a release installed and reported to core.
//
// Every line printed is fixed text with the run's own facts: never a secret, a path of the site,
// an address of the hosting or what a server answered. The repository decides nothing here:
// Vault, the release API, the CA and APP_ENV come from the runner's configuration.

export interface DeployInput {
  run: RunFacts
  wrap: DeployWrap
  machine: MachineFacts
  /** `gitea.token` of the job: reads its own repository. */
  jobToken: string
  data: DeployWrapData
}

export interface DeployStepIo {
  /** The environment of the step; the secrets are removed from it once read. */
  env: Record<string, string | undefined>
  print(line: string): void
  /** A step output (`$GITHUB_OUTPUT`). */
  setOutput(name: string, value: string): void
  /** The release API answers its health check, within the wait the command allows. */
  reachable(releaseApiUrl: string): Promise<boolean>
  /** `sys/wrapping/unwrap` at `vaultAddr`; null — spent, revoked or expired. */
  unwrap(vaultAddr: string, token: string): Promise<Record<string, string> | null>
  deploy(input: DeployInput): Promise<DeployResult>
}

const why: Record<Exclude<RunMatch, { matched: true }>['reason'], string> = {
  no_secret: 'the repository has no deploy secret — not for this run',
  unreadable: 'the deploy secret is not readable — not for this run',
  another_run: 'the deploy secret is for another tag or commit — not for this run',
}

const ends: Record<DeployOutcome, string> = {
  installed: 'the release is installed',
  rolled_back: 'the release was rolled back: the site is as it was',
  failed: 'the release was not installed: nothing was written',
  unknown: 'what the site holds could not be proved: the operator decides',
}

/** The run's facts and the verdict on the secret; null — not a release tag of a site. */
function matched(io: DeployStepIo): { run: RunFacts; match: RunMatch } | null {
  const say = (line: string) => io.print(`deploy-step: ${line}`)
  const run = runFactsFrom(io.env)
  if (run === null) {
    say('not a release tag of a site — not for this run')
    return null
  }
  say(`run event=${run.event} ref=${run.ref} ref_name=${run.refName} sha=${run.sha}`)
  const match = matchRun(io.env.RADITI_DEPLOY_WRAP, run)
  say(match.matched ? 'the deploy secret is for this run' : why[match.reason])
  return { run, match }
}

async function commandMatch(io: DeployStepIo): Promise<number> {
  const result = matched(io)
  delete io.env.RADITI_DEPLOY_WRAP
  io.setOutput('matched', result?.match.matched ? 'true' : 'false')
  return 0
}

async function commandRun(io: DeployStepIo): Promise<number> {
  const say = (line: string) => io.print(`deploy-step: ${line}`)
  const result = matched(io)
  // Nothing this process starts needs the secrets.
  delete io.env.RADITI_DEPLOY_WRAP
  const jobToken = io.env.RADITI_JOB_TOKEN
  delete io.env.RADITI_JOB_TOKEN
  if (!result || !result.match.matched) return 0
  const { run, match } = result
  const machine = machineFactsFrom(io.env)
  if (machine === null || !jobToken || !runServerAllowed(run, machine)) {
    say('the runner is not configured for releases — nothing was unwrapped')
    return 1
  }

  if (!(await io.reachable(machine.releaseApiUrl))) {
    say('the release API did not answer — nothing was unwrapped')
    return 1
  }
  let data: Record<string, string> | null
  try {
    data = await io.unwrap(machine.vaultAddr, match.wrap.wrapToken)
  } catch {
    say('Vault did not answer — nothing was unwrapped')
    return 1
  }
  const unwrapped = deployWrapDataSchema.safeParse(data)
  if (data === null || !unwrapped.success || !deployWrapDataMatches(unwrapped.data, match.wrap)) {
    say('the deploy secret was already used, has expired or holds something else')
    return 1
  }

  let deployed: DeployResult
  try {
    deployed = await io.deploy({ run, wrap: match.wrap, machine, jobToken, data: unwrapped.data })
  } catch {
    say('the release API did not give this attempt its manifest — nothing was written')
    return 1
  }
  say(ends[deployed.outcome])
  if (!deployed.told) {
    // core would take the job for a silent one: the end is not what it knows.
    say('core did not take the end of the deploy')
    return 1
  }
  return deployed.outcome === 'installed' ? 0 : 1
}

const commands: Record<string, (io: DeployStepIo) => Promise<number>> = {
  match: commandMatch,
  run: commandRun,
}

/** The exit code of `cli.js <command>`. */
export async function deployStepCommand(
  args: readonly string[],
  io: DeployStepIo,
): Promise<number> {
  const name = args.length === 1 ? args[0]! : ''
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined
  if (!command) {
    io.print('deploy-step: usage: cli.js match|run')
    return 2
  }
  return command(io)
}
