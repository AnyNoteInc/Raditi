// What a stand does before the real OpenCode CLI can take a turn on the synthetic Z.ai, shared
// by verify:llm-gateway (verify-llm-zai.mjs) and verify:agent-content: the role llm without an
// egress proxy, the plan key imported by the operator command, the rows an operator switches on
// and a home of the CLI that holds nothing but the session state.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import process from 'node:process'

import { dockerCommand } from '../../../infra/dev/llm-verify/cli.mjs'
import { repository, run } from '../../../infra/dev/llm-verify/stack.mjs'

export const ZAI_BACKEND = 'zai-coding'
export const ZAI_MODEL = 'glm-5.3'
export const ZAI_PROFILE = 'glm-5.3-standard'
/** What the CLI is given as the address of its provider: the route of sandbox-gw. */
export const ZAI_GATEWAY_BASE_URL = 'http://sandbox-gw:8080/zai/v4'
export const OPENCODE_HOME = '/agent-home/opencode'
const PROXY_VARIABLES = [
  'LLM_EGRESS_PROXY_URL',
  'LLM_EGRESS_CA_FILE',
  'LLM_EGRESS_CLIENT_CERT_FILE',
  'LLM_EGRESS_CLIENT_KEY_FILE',
]

/**
 * The environment of a role llm that reaches Z.ai on a connection of its own, as it reaches
 * api.z.ai in the product: no egress proxy, and the provider's origin pointed at the stand's
 * fake under the name its certificate carries.
 */
export function zaiDirectEnvironment(env, stack) {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => !PROXY_VARIABLES.includes(name))),
    LLM_BACKEND_URL_ZAI_CODING: stack.providerOrigin,
  }
}

/** The operator commands on the direct path: no egress proxy in their environment either. */
export function zaiOperator(stack, upstreamCaFile) {
  const env = {
    APP_ENV: 'test',
    DATABASE_URL: stack.databaseUrl,
    VAULT_ADDR: stack.vaultAddress,
    LLM_UPSTREAM_CA_FILE: upstreamCaFile,
    LLM_BACKEND_URL_ZAI_CODING: stack.providerOrigin,
  }
  return (command, args, input) =>
    run(
      process.execPath,
      [join(repository, `apps/orchestrator/scripts/subscription-${command}.mjs`), ...args],
      { input, env, allowFailure: true },
    )
}

/** `subscriptions:login` with the plan key on stdin: the account is created switched off. */
export const zaiLogin = (operator, { label, writerFile, key }) =>
  operator(
    'login',
    [
      '--backend',
      ZAI_BACKEND,
      '--label',
      label,
      '--plan',
      'lite',
      '--vault-token-file',
      writerFile,
    ],
    `${key}\n`,
  )

/**
 * What an operator switches on after the import: the provider, the seeds' own profile (glm-5.3
 * with the reserve the body policy's output ceiling needs), a stand rate — without one the
 * product issues no turn key — the driver and the account. The windows of the account are
 * nobody's to write but a probe's.
 */
export async function switchOnZai(db, { accountId, ratesUrl }) {
  const provider = await db.llmProvider.update({
    where: { slug: ZAI_BACKEND },
    data: { enabled: true },
  })
  const profile = await db.llmModel.findFirstOrThrow({
    where: { providerId: provider.id, slug: ZAI_PROFILE },
  })
  assert.equal(profile.providerModelId, ZAI_MODEL)
  assert.equal(profile.reserveOutputTokens, 32_000)
  await db.llmModelPrice.create({
    data: {
      modelId: profile.id,
      effectiveFrom: new Date(Date.now() - 60_000),
      inputPer1m: '10',
      cacheReadPer1m: '1',
      outputPer1m: '30',
      vatRate: '0.22',
      sourceUrl: ratesUrl,
    },
  })
  await db.agentDriver.update({ where: { id: 'opencode' }, data: { enabled: true } })
  await db.subscriptionAccount.update({ where: { id: accountId }, data: { enabled: true } })
  return db.llmModel.update({ where: { id: profile.id }, data: { enabled: true } })
}

/**
 * What survives between two turns of a task is the session state the driver names and nothing
 * else: the home of the CLI is new in every sandbox. `keep` leaves the two database files.
 */
const RESET_HOME = `const fs=require('node:fs'),path=require('node:path');
const home=${JSON.stringify(OPENCODE_HOME)},data=path.join(home,'.local/share/opencode');
const open=(dir)=>{try{fs.chmodSync(dir,0o700)}catch{}
  for(const entry of fs.readdirSync(dir,{withFileTypes:true}))
    if(entry.isDirectory()&&!entry.isSymbolicLink())open(path.join(dir,entry.name))};
const saved=[];
if(fs.existsSync(home)){open(home);
  if(process.argv[1]==='keep')for(const name of['opencode.db','opencode.db-wal'])
    try{saved.push([name,fs.readFileSync(path.join(data,name))])}catch{}
  for(const name of fs.readdirSync(home))fs.rmSync(path.join(home,name),{recursive:true,force:true})}
if(saved.length){fs.mkdirSync(data,{recursive:true,mode:0o700});
  for(const[name,bytes]of saved)fs.writeFileSync(path.join(data,name),bytes,{mode:0o600})}
fs.rmSync('/workspace/.raditi-opencode-held',{recursive:true,force:true});`

/** The home of the CLI as a new sandbox has it: empty, or, to resume, the session state alone. */
export async function resetOpencodeHome(containerName, { keepSession = false } = {}) {
  const reset = await dockerCommand([
    'exec',
    containerName,
    'node',
    '-e',
    RESET_HOME,
    keepSession ? 'keep' : 'new',
  ])
  assert.equal(reset.code, 0, 'The home of the CLI could not be prepared')
}
