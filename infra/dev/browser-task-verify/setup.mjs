// What the scenarios need before a task: clients of web signed up as web signs them up, the
// synthetic Z.ai account and its profiles switched on by the operator's own commands with the
// rates of the stand, files uploaded the way the cabinet uploads them (`attachment.start`, then
// `PUT /api/attachments/<id>`).
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { SYNTHETIC_ZAI_KEY } from '../llm-verify/fake-zai.mjs'
import { customerOf } from '../release-verify/runtime.mjs'
import { STAND_PROFILES, operatorEnvironment, standRatesFile } from './stand.mjs'

/**
 * A client of web: the form's sign-up with both required consents from an address of its own (the
 * sign-up limit of better-auth is per address), the address of the mail confirmed in the database
 * (the letters are verify:billing's), then the sign-in that opens the session.
 */
export async function signUp(rt, { webUrl, db, address, name, login }) {
  const client = customerOf(rt, { webUrl, address })
  const email = `${login}-${randomBytes(4).toString('hex')}@example.ru`
  const password = rt.secret(randomBytes(18).toString('base64url'))
  const signUpAnswer = await client.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      lastName: 'Проверкина',
      email,
      password,
      acceptTerms: true,
      acceptPersonalData: true,
      marketing: false,
    }),
  })
  assert.equal(signUpAnswer.status, 200, `sign-up answered ${signUpAnswer.status}`)
  const user = await db.user.update({ where: { email }, data: { emailVerified: true } })
  const signIn = await client.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  assert.equal(signIn.status, 200, `sign-in answered ${signIn.status}`)
  assert.ok(client.cookie().includes('better-auth'), 'The sign-in opened no session')
  for (const pair of client.cookie().split('; ')) rt.secret(pair.slice(pair.indexOf('=') + 1))
  return { ...client, id: user.id, email, address }
}

/**
 * The synthetic Z.ai account through the operator's own command, the provider, the standard and
 * the heavy profile and the account switched on, then `billing:rates` writes the stand rates and
 * the credit rate with one moment — the one command that writes either.
 */
export async function switchOnModel(rt, { db, copy, context, vault, directory }) {
  const writerFile = join(directory, 'subscriptions-writer.token')
  await writeFile(writerFile, vault.tokens['subscriptions-writer'], { mode: 0o400 })
  const llmApp = join(copy, 'apps/llm')
  const login = await rt.run(
    process.execPath,
    [
      join(llmApp, 'scripts/subscription-login.mjs'),
      ...['--backend', 'zai-coding', '--label', 'browser-task-verify', '--plan', 'lite'],
      ...['--vault-token-file', writerFile],
    ],
    { cwd: llmApp, env: operatorEnvironment(context), input: `${SYNTHETIC_ZAI_KEY}\n` },
  )
  const accountId = JSON.parse(login.output.slice(login.output.indexOf('{'))).accountId
  const provider = await db.llmProvider.update({
    where: { slug: 'zai-coding' },
    data: { enabled: true },
  })
  const profiles = []
  for (const slug of STAND_PROFILES)
    profiles.push(await db.llmModel.findFirstOrThrow({ where: { providerId: provider.id, slug } }))
  await db.subscriptionAccount.update({ where: { id: accountId }, data: { enabled: true } })
  await db.llmModel.updateMany({
    where: { id: { in: profiles.map((profile) => profile.id) } },
    data: { enabled: true },
  })
  const ratesFile = join(directory, 'stand-rates.json')
  await writeFile(ratesFile, JSON.stringify(standRatesFile(), null, 2), { mode: 0o600 })
  const coreApp = join(copy, 'apps/core')
  const rates = await rt.run(
    process.execPath,
    [
      join(coreApp, 'scripts/billing-rates.mjs'),
      ...[
        '--file',
        ratesFile,
        '--reason',
        'Стенд задач в браузере: ставки профилей и курс кредита',
      ],
      ...['--confirm-exposure', '--operator', 'browser-task-verify'],
    ],
    { cwd: coreApp, env: operatorEnvironment(context) },
  )
  const rate = await db.creditRate.findFirst({ orderBy: { effectiveFrom: 'desc' } })
  for (const profile of profiles) {
    const price = await db.llmModelPrice.findFirst({ where: { modelId: profile.id } })
    assert.ok(
      price && rate && price.effectiveFrom.getTime() === rate.effectiveFrom.getTime(),
      `billing:rates wrote no rate and price of ${profile.slug}: ${rt.redact(rates.output).slice(-600)}`,
    )
  }
  return { accountId }
}

/**
 * A file as the cabinet sends it: `attachment.start` names it, then its bytes go to
 * `PUT /api/attachments/<id>` with the session, the cabinet's Origin and the length.
 * Returns the id and the answer of the upload.
 */
export async function uploadFile(client, { siteId, name, type, bytes, size = bytes.byteLength }) {
  const started = await client.call('mutation', 'attachment.start', { siteId, name, size, type })
  if (!started.ok) return { id: null, started, upload: null }
  const { attachmentId, uploadPath } = started.data
  const upload = await client.request(uploadPath, {
    method: 'PUT',
    headers: { 'content-type': type, 'content-length': String(bytes.byteLength) },
    body: bytes,
  })
  const text = await upload.text().catch(() => '')
  return { id: attachmentId, uploadPath, started, upload: { status: upload.status, text } }
}
