// What a stand does before the real OpenCode CLI can take a turn on the synthetic Z.ai, shared
// by verify:llm-gateway (verify-llm-zai.mjs, verify-llm-zai-api.mjs) and verify:agent-content:
// the role llm without an egress proxy, the provider key imported by the operator command, the
// rows an operator switches on and a home of the CLI that holds nothing but the session state.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import process from 'node:process'

import { dockerCommand } from '../../../infra/dev/llm-verify/cli.mjs'
import {
  SYNTHETIC_ZAI_API_KEY,
  SYNTHETIC_ZAI_KEY,
  SYNTHETIC_ZAI_ROTATED_API_KEY,
  SYNTHETIC_ZAI_ROTATED_KEY,
  ZAI_PATHS,
} from '../../../infra/dev/llm-verify/fake-zai.mjs'
import { repository, run } from '../../../infra/dev/llm-verify/stack.mjs'
import {
  llmBackends,
  zaiApiBackend,
  zaiCodingBackend,
} from '../../../packages/llm-backends/src/index.ts'
import { llmGatewayBaseUrl } from '../src/llm/backends.ts'

/** The address of sandbox-gw in the network of the CLI container. */
export const SANDBOX_GATEWAY = 'http://sandbox-gw:8080'
export const ZAI_MODEL = 'glm-5.3'
export const ZAI_PROFILE = 'glm-5.3-standard'

/**
 * The two offers of Z.ai as a stand drives them: the backend and the provider row of its slug,
 * the plan an operator names at import, the route of sandbox-gw and the base URL the CLI is
 * given for it (core's own helper), the path of the synthetic provider it ends on, the label
 * the fake gives its key, and the synthetic keys — the first one and the operator's next.
 */
export const ZAI_OFFERS = Object.freeze({
  plan: Object.freeze({
    backend: zaiCodingBackend.id,
    plan: 'lite',
    route: zaiCodingBackend.routes[0].path,
    gatewayBaseUrl: llmGatewayBaseUrl(SANDBOX_GATEWAY, zaiCodingBackend),
    providerPath: ZAI_PATHS.chat,
    credential: 'plan-key',
    key: SYNTHETIC_ZAI_KEY,
    rotatedKey: SYNTHETIC_ZAI_ROTATED_KEY,
  }),
  // The pay-per-token API (П15): an account with a balance and no windows.
  api: Object.freeze({
    backend: zaiApiBackend.id,
    plan: 'payg',
    route: zaiApiBackend.routes[0].path,
    gatewayBaseUrl: llmGatewayBaseUrl(SANDBOX_GATEWAY, zaiApiBackend),
    providerPath: ZAI_PATHS.apiChat,
    credential: 'api-key',
    key: SYNTHETIC_ZAI_API_KEY,
    rotatedKey: SYNTHETIC_ZAI_ROTATED_API_KEY,
  }),
})
export const ZAI_BACKEND = ZAI_OFFERS.plan.backend
/** What the CLI is given as the address of its provider: the route of sandbox-gw. */
export const ZAI_GATEWAY_BASE_URL = ZAI_OFFERS.plan.gatewayBaseUrl
export const OPENCODE_HOME = '/agent-home/opencode'
const PROXY_VARIABLES = [
  'LLM_EGRESS_PROXY_URL',
  'LLM_EGRESS_CA_FILE',
  'LLM_EGRESS_CLIENT_CERT_FILE',
  'LLM_EGRESS_CLIENT_KEY_FILE',
]

/**
 * The stand variable of every origin a backend declares, each pointed at the stand's fake: the
 * offers of Z.ai share one origin and so one variable, which a stand sets once.
 */
export function zaiOriginOverrides(stack) {
  return Object.fromEntries(
    llmBackends
      .flatMap((backend) => backend.egress)
      .map((origin) => [origin.overrideEnv, stack.providerOrigin]),
  )
}

/**
 * The environment of a role llm that reaches Z.ai on a connection of its own, as it reaches
 * api.z.ai in the product: no egress proxy, and the provider's origin pointed at the stand's
 * fake under the name its certificate carries.
 */
export function zaiDirectEnvironment(env, stack) {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => !PROXY_VARIABLES.includes(name))),
    ...zaiOriginOverrides(stack),
  }
}

/** The operator commands on the direct path: no egress proxy in their environment either. */
export function zaiOperator(stack, upstreamCaFile) {
  const env = {
    APP_ENV: 'test',
    DATABASE_URL: stack.databaseUrl,
    VAULT_ADDR: stack.vaultAddress,
    LLM_UPSTREAM_CA_FILE: upstreamCaFile,
    ...zaiOriginOverrides(stack),
  }
  return (command, args, input) =>
    run(
      process.execPath,
      [join(repository, `apps/orchestrator/scripts/subscription-${command}.mjs`), ...args],
      { input, env, allowFailure: true },
    )
}

/**
 * `subscriptions:login` with the provider key on stdin, for the plan unless another offer is
 * named: the account is created switched off.
 */
export const zaiLogin = (operator, { label, writerFile, key, offer = ZAI_OFFERS.plan }) =>
  operator(
    'login',
    [
      '--backend',
      offer.backend,
      '--label',
      label,
      '--plan',
      offer.plan,
      '--vault-token-file',
      writerFile,
    ],
    `${key}\n`,
  )

/** The stand rates of the profile, ₽ per million tokens with VAT: nobody's approved rates. */
export const ZAI_STAND_RATES = Object.freeze({
  inputPer1m: '10',
  cacheReadPer1m: '1',
  outputPer1m: '30',
  vatRate: '0.22',
})

/**
 * What an operator switches on after the import: the provider, the seeds' own profile (glm-5.3
 * with the reserve the body policy's output ceiling needs), a stand rate — without one the
 * product issues no turn key — and the account. The driver is not the operator's to switch:
 * its row is on as the migrations and the seeds leave it, and the stand stands on that. The
 * windows of the account are nobody's to write but a probe's.
 */
export async function switchOnZai(db, { accountId, ratesUrl, backend = ZAI_BACKEND }) {
  const provider = await db.llmProvider.update({
    where: { slug: backend },
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
      ...ZAI_STAND_RATES,
      sourceUrl: ratesUrl,
    },
  })
  assert.equal(
    (await db.agentDriver.findUniqueOrThrow({ where: { id: 'opencode' } })).enabled,
    true,
  )
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

/**
 * One more profile of the backend's provider switched on at the stand rate: the levels a run
 * asks besides the standard one. Found by the provider as well as the slug, since both offers
 * name their profiles alike.
 */
export async function switchOnProfile(db, { backend = ZAI_BACKEND, slug, ratesUrl }) {
  const profile = await db.llmModel.findFirstOrThrow({
    where: { slug, provider: { slug: backend } },
  })
  await db.llmModelPrice.create({
    data: {
      modelId: profile.id,
      effectiveFrom: new Date(Date.now() - 60_000),
      ...ZAI_STAND_RATES,
      sourceUrl: ratesUrl,
    },
  })
  return db.llmModel.update({ where: { id: profile.id }, data: { enabled: true } })
}
