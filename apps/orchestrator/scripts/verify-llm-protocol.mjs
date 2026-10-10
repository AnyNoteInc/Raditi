// Protocol checks on the owned B13 stack. No host login or external account is read. The
// scenarios of the platform run once, on the group they are given (its ids and forms are data:
// verify-llm-zai-forms.mjs); what is Codex's own stays below them until Codex is removed.
import assert from 'node:assert/strict'

import { eventually, run } from '../../../infra/dev/llm-verify/stack.mjs'

// Generate binary/large requests inside the unprivileged CLI namespace. Its key enters
// only through stdin, never Docker arguments, environment or container configuration.
const generatedRequest = `
import { gzipSync } from 'node:zlib';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const value = JSON.parse(input);
const data = value.kind === 'gzip' ? gzipSync(value.body) : value.body.replace(value.fill, 'x'.repeat(value.bytes ?? 0));
try {
  const response = await fetch('http://sandbox-gw:8080' + value.path, {method:'POST',headers:{authorization:'Bearer '+value.key,'content-type':'application/json','user-agent':value.agent,...(value.kind === 'gzip' ? {'content-encoding':'gzip'} : {})},body:data,signal:AbortSignal.timeout(15000)});
  const text = await response.text(); process.stdout.write(JSON.stringify({status:response.status,bytes:text.length}));
} catch { process.stdout.write(JSON.stringify({status:null,transportRejected:true})); }
`
const networkProbe = `
import { connect } from 'node:net';
import { Resolver } from 'node:dns/promises';
const tcp = () => new Promise(resolve => {const socket=connect({host:'1.1.1.1',port:443});const timer=setTimeout(()=>{socket.destroy();resolve(false)},1000);socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve(true)});socket.once('error',()=>{clearTimeout(timer);resolve(false)})});
const resolver=new Resolver({timeout:500,tries:1});resolver.setServers(['127.0.0.11']);
const dns=resolver.resolve4('example.com').then(()=>true,()=>false);
const [directIp,dnsResolved]=await Promise.all([tcp(),dns]);process.stdout.write(JSON.stringify({directIp,dnsResolved}));
`

export async function verifyProtocol(group) {
  const { db, core, cli, passed, ids } = group
  const owned = new Map()
  const acquire = async (overrides) => {
    const turn = await group.issued(overrides)
    owned.set(turn.ref.taskId, turn)
    return turn
  }
  const release = async (turn) => {
    if (!owned.has(turn.ref.taskId)) return
    await group.revoke(turn)
    owned.delete(turn.ref.taskId)
  }
  try {
    await group.provider(group.answers.text())
    const turn = await acquire()
    const before = await group.providerRequests()
    for (const [body, headers] of group.refusedRequests())
      assert.equal(
        (await group.request(turn, { body, headers })).status,
        400,
        'Invalid protocol body escaped the gateway',
      )
    for (const path of group.closedPaths)
      assert.equal((await group.request(turn, { path })).status, 403)
    // A key of this backend opens no route of another one, while there is another one.
    for (const other of group.otherBackendRequests)
      assert.equal((await group.request(turn, other)).status, 403)
    assert.equal(await group.providerRequests(), before)
    assert.equal((await group.calls(turn)).length, 0)

    // The fill is a JSON string of its own in the body: the container writes the bytes.
    const fill = `fill-${turn.ref.taskId}`
    const generate = async (kind, bytes) => {
      const result = await run(
        'docker',
        ['exec', '-i', cli.containerName, 'node', '--input-type=module', '-e', generatedRequest],
        {
          input: JSON.stringify({
            kind,
            bytes,
            fill,
            key: turn.values.llmApiKey,
            path: group.route,
            agent: group.userAgent,
            body: JSON.stringify(
              group.body(kind === 'large' ? fill : 'Synthetic compressed body.'),
            ),
          }),
          timeoutMs: 25_000,
        },
      )
      return JSON.parse(result.stdout)
    }
    assert.equal(
      (await generate('gzip')).status,
      400,
      'Compressed request bytes must not reach a provider',
    )
    assert.equal(await group.providerRequests(), before)
    // The production JSON/route limit is 16 MiB; 1 MiB is not its rejection boundary.
    assert.equal((await generate('large', 1024 * 1024 + 1024)).status, 200)
    await group.settled(turn, 1)
    assert.equal(await group.providerRequests(), before + 1)
    const oversized = await generate('large', 16 * 1024 * 1024 + 1024)
    assert.ok(
      oversized.status === 413 || oversized.status === 502 || oversized.transportRejected,
      'A body beyond the gateway limit must fail before provider admission',
    )
    assert.equal(await group.providerRequests(), before + 1)
    assert.equal((await group.calls(turn)).length, 1)
    // What the body policy rewrites instead of refusing reaches the provider rewritten.
    assert.equal(
      (await group.request(turn, { body: { ...group.body(), ...group.rewritten.change } })).status,
      200,
    )
    await group.settled(turn, 2)
    assert.partialDeepStrictEqual(
      (await group.lastProviderRequest()).body,
      group.rewritten.received,
    )
    await release(turn)
    passed(
      'protocol/model/path/backend refusals, compressed/large bodies and streaming normalization',
    )

    const foreignSource = await acquire({ boundSource: '192.0.2.15' })
    const reached = await group.providerRequests()
    assert.equal((await group.request(foreignSource)).status, 401)
    assert.equal(await group.providerRequests(), reached)
    assert.equal((await group.calls(foreignSource)).length, 0)
    await release(foreignSource)
    passed('a turn key bound to another runner address is rejected before provider admission')

    const direct = await run(
      'docker',
      ['exec', cli.containerName, 'node', '--input-type=module', '-e', networkProbe],
      { timeoutMs: 5000 },
    )
    assert.deepEqual(JSON.parse(direct.stdout), { directIp: false, dnsResolved: false })
    passed('guarded CLI cannot reach an external IP or Docker embedded DNS')

    const client = await group.task()
    let clearance
    try {
      await db.workspace.update({ where: { id: group.workspaceId }, data: { dataClass: 'client' } })
      await assert.rejects(
        group.issue(client),
        (error) => error.code === 'CROSS_BORDER_NOT_CLEARED',
      )
      assert.equal(await db.llmKey.count({ where: { taskId: client.ref.taskId } }), 0)
      const provider = await db.llmProvider.findUniqueOrThrow({ where: { slug: ids.backend } })
      clearance = await db.crossBorderClearance.create({
        data: {
          providerId: provider.id,
          // No country is established for this provider yet: a code that belongs to none.
          countries: 'ZZ',
          notice22Ref: 'synthetic-b13',
          notice22Date: new Date('2020-01-01'),
          recipientsAssessedOn: new Date('2020-01-01'),
          notice12Ref: 'synthetic-b13',
          notice12ReceivedOn: new Date('2020-01-01'),
          transferAllowedFrom: new Date('2020-01-01'),
          documents: 'Synthetic fixture, no legal clearance represented.',
          recordedBy: 'synthetic-b13',
        },
      })
      const cleared = group.keep(client, await group.issue(client))
      owned.set(cleared.ref.taskId, cleared)
      assert.deepEqual(await core.call('recover', { ref: cleared.ref }), cleared.values)
      await release(cleared)
    } finally {
      await db.workspace.update({
        where: { id: group.workspaceId },
        data: { dataClass: 'synthetic' },
      })
      if (clearance) await db.crossBorderClearance.delete({ where: { id: clearance.id } })
    }
    passed(
      'client-data issuance fails without clearance and succeeds with an owned synthetic clearance',
    )

    const repeated = await group.task()
    const duplicates = await Promise.allSettled(
      Array.from({ length: 4 }, () => group.issue(repeated)),
    )
    const first = duplicates.find((result) => result.status === 'fulfilled')
    if (first) owned.set(repeated.ref.taskId, group.keep(repeated, first.value))
    assert.ok(
      duplicates.every((result) => result.status === 'fulfilled'),
      'Concurrent identical issuance must recover one write-once key',
    )
    for (const result of duplicates) assert.deepEqual(result.value, first.value)
    assert.equal(await db.llmKey.count({ where: { taskId: repeated.ref.taskId } }), 1)
    assert.equal(await db.taskAccountBinding.count({ where: { taskId: repeated.ref.taskId } }), 1)
    await release(owned.get(repeated.ref.taskId))

    const independent = await Promise.all([group.task(), group.task()])
    const admissions = await Promise.allSettled(independent.map((turn) => group.issue(turn)))
    for (let index = 0; index < admissions.length; index++)
      if (admissions[index].status === 'fulfilled')
        owned.set(
          independent[index].ref.taskId,
          group.keep(independent[index], admissions[index].value),
        )
    assert.equal(
      admissions.filter((result) => result.status === 'fulfilled').length,
      1,
      'A capacity of one turn must fence concurrent distinct turns',
    )
    const rejected = admissions.find((result) => result.status === 'rejected')
    assert.ok(
      ['SUBSCRIPTION_BUSY', 'SUBSCRIPTION_WAIT'].includes(rejected.reason.code),
      'Capacity contention must be a domain refusal, never a deadlock',
    )
    for (const turn of [...owned.values()]) await release(turn)
    passed(
      'parallel identical issue returns one key; distinct turns of a one-turn account serialize without a database deadlock',
    )
  } finally {
    const cleanup = await Promise.allSettled([...owned.values()].map(release))
    await group.provider(group.answers.text())
    assert.ok(
      cleanup.every((result) => result.status === 'fulfilled'),
      'Protocol turn-key cleanup failed',
    )
  }
}

/**
 * Codex's own plan tool between two answers: a form no other CLI of the stand has, run with the
 * hand-written configuration of the old path. Removed with Codex (G8).
 */
export async function verifyCodexPlanRound(ctx) {
  const { db, core, cli, control, issued, passed, secretMarkers } = ctx
  const providerPath = '/backend-api/codex/responses'
  const countRequests = async () =>
    (await control('state')).requests.filter((request) => request.path === providerPath).length
  await control('scenario', { backend: 'codex', scenario: 'plan-then-text' })
  const turn = await issued('openai-chatgpt')
  secretMarkers?.add(turn.values.llmApiKey)
  try {
    const before = await countRequests()
    const result = await cli.run({
      driver: 'codex',
      key: turn.values.llmApiKey,
      prompt: 'Prepare the synthetic plan, then report completion.',
    })
    assert.equal(result.code, 0, 'Codex plan-then-text did not finish')
    assert.equal((await countRequests()) - before, 2)
    assert.equal(result.lastMessage, 'Synthetic B13 complete.')
    assert.equal(result.events.filter((event) => event.type === 'turn.completed').length, 1)
    await eventually(async () => {
      const rows = await db.llmCall.findMany({ where: { key: { taskId: turn.ref.taskId } } })
      return rows.length === 2 && rows.every((row) => row.state !== 'open')
    })
  } finally {
    await core.call('revoke', { ref: turn.ref })
    await control('scenario', { backend: 'codex', scenario: 'text' })
  }
  passed('real Codex completes a plan/tool round followed by final text')
}
