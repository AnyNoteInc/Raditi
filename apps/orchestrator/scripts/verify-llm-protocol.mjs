// Real CLI/protocol checks on the owned B13 stack. No host login or external account is read.
import assert from 'node:assert/strict'

import { eventually, run } from '../../../infra/dev/llm-verify/stack.mjs'

const profiles = {
  'openai-chatgpt': {
    driver: 'codex',
    path: '/codex/responses',
    providerPath: '/backend-api/codex/responses',
    agent: 'codex_exec/0.158.0',
    model: 'gpt-6-sol',
  },
  'kimi-code': {
    driver: 'kimi',
    path: '/kimi/v1/chat/completions',
    providerPath: '/coding/v1/chat/completions',
    agent: 'kimi-code-cli/2.1.1',
    model: 'k3-256k',
  },
}
const bodyFor = (backend, text = 'Synthetic protocol fixture.') =>
  backend === 'openai-chatgpt'
    ? { model: profiles[backend].model, input: text, stream: true, store: false }
    : { model: profiles[backend].model, messages: [{ role: 'user', content: text }], stream: true }

// Generate binary/large requests inside the unprivileged CLI namespace. Its key enters
// only through stdin, never Docker arguments, environment or container configuration.
const generatedRequest = `
import { gzipSync } from 'node:zlib';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const value = JSON.parse(input);
const body = {model:'gpt-6-sol',input:value.kind === 'large' ? 'x'.repeat(value.bytes) : 'Synthetic compressed body.',stream:true,store:false};
const data = value.kind === 'gzip' ? gzipSync(JSON.stringify(body)) : JSON.stringify(body);
try {
  const response = await fetch('http://sandbox-gw:8080/codex/responses', {method:'POST',headers:{authorization:'Bearer '+value.key,'content-type':'application/json','user-agent':'codex_exec/0.158.0',...(value.kind === 'gzip' ? {'content-encoding':'gzip'} : {})},body:data,signal:AbortSignal.timeout(15000)});
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

export async function verifyProtocol(ctx) {
  const { db, core, cli, control, task, issued, passed, codex, kimi, promptMarker, secretMarkers } =
    ctx
  const accounts = { 'openai-chatgpt': codex.accountId, 'kimi-code': kimi.accountId }
  const owned = new Map()
  const remember = (turn) => {
    owned.set(turn.ref.taskId, turn)
    secretMarkers?.add(turn.values.llmApiKey)
  }
  const acquire = async (backend, overrides) => {
    const turn = await issued(backend, overrides)
    remember(turn)
    return turn
  }
  const release = async (turn) => {
    if (!owned.has(turn.ref.taskId)) return
    await core.call('revoke', { ref: turn.ref })
    owned.delete(turn.ref.taskId)
  }
  const withTurn = async (backend, action) => {
    const turn = await acquire(backend)
    try {
      return await action(turn)
    } finally {
      await release(turn)
    }
  }
  const scenario = (backend, value) =>
    control('scenario', { backend: profiles[backend].driver, scenario: value })
  const countRequests = async (backend) =>
    (await control('state')).requests.filter(
      (request) => request.path === profiles[backend].providerPath,
    ).length
  const keyRow = (turn) =>
    db.llmKey.findUniqueOrThrow({
      where: {
        taskId_turnNo_firstEpoch: {
          taskId: turn.ref.taskId,
          turnNo: turn.ref.turn,
          firstEpoch: turn.ref.epoch,
        },
      },
    })
  const calls = (turn) =>
    db.llmCall.findMany({
      where: { key: { taskId: turn.ref.taskId } },
      orderBy: { startedAt: 'asc' },
    })
  const settled = (turn, expected) =>
    eventually(async () => {
      const rows = await calls(turn)
      return rows.length === expected && rows.every((row) => row.state !== 'open') ? rows : null
    })
  const request = (
    backend,
    turn,
    body = bodyFor(backend),
    headers = {},
    path = profiles[backend].path,
  ) =>
    cli.request({
      key: turn.values.llmApiKey,
      path,
      headers: {
        'content-type': 'application/json',
        'user-agent': profiles[backend].agent,
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  const restoreWindow = async (backend) => {
    await scenario(backend, 'text')
    await db.subscriptionAccount.update({
      where: { id: accounts[backend] },
      data: {
        coolingUntil: null,
        headroomPct: '90',
        limitsSeenAt: new Date(),
        limitWindows: [
          { name: '5h', usedPct: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
        ],
      },
    })
  }
  try {
    // Real clients must survive the gateway's real account pause after the first 503.
    for (const backend of Object.keys(profiles)) {
      await scenario(backend, 'transient503')
      await withTurn(backend, async (turn) => {
        const before = await countRequests(backend)
        const result = await cli.run({
          driver: profiles[backend].driver,
          key: turn.values.llmApiKey,
          prompt: `${promptMarker}. Complete the synthetic retry scenario.`,
          timeoutMs: 120_000,
        })
        assert.equal(
          result.code,
          0,
          `${profiles[backend].driver} did not recover from a transient provider 503`,
        )
        assert.equal(
          (await countRequests(backend)) - before,
          2,
          '503 must make exactly two provider requests',
        )
        const rows = await settled(turn, 2)
        assert.equal(rows.filter((row) => row.state === 'completed').length, 1)
        assert.equal(
          (await keyRow(turn)).lastRefusal,
          'transient',
          'The refusal journal must survive the later success',
        )
      })
      passed(
        `real ${profiles[backend].driver} retries 503 and finishes with exactly two provider requests`,
      )
      await scenario(backend, 'text')
    }

    for (const backend of Object.keys(profiles)) {
      // Issue before the fake starts reporting exhausted windows.
      await withTurn(backend, async (turn) => {
        await scenario(backend, 'final_quota')
        const before = await countRequests(backend)
        const result = await cli.run({
          driver: profiles[backend].driver,
          key: turn.values.llmApiKey,
          prompt: 'Synthetic final quota refusal.',
          timeoutMs: 60_000,
        })
        assert.notEqual(result.code, 0, 'Final quota must end the CLI turn')
        assert.equal(result.timedOut, false, 'Final quota must finish without a timeout')
        assert.equal(
          (await countRequests(backend)) - before,
          1,
          'Final quota must not be retried by the CLI',
        )
        await settled(turn, 1)
        const row = await keyRow(turn)
        assert.equal(row.lastRefusal, 'subscription_limit')
        assert.ok(row.lastRefusalAt instanceof Date)
        await eventually(
          async () =>
            (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accounts[backend] } }))
              .coolingUntil > new Date(),
        )
        assert.equal(
          (await db.subscriptionAccount.findUniqueOrThrow({ where: { id: accounts[backend] } }))
            .health,
          'ok',
        )
        assert.equal((await request(backend, turn)).status, 429)
        assert.equal(
          (await countRequests(backend)) - before,
          1,
          'A refused key must not reach the exhausted provider again',
        )
        await release(turn)
        assert.equal(
          (await keyRow(turn)).lastRefusal,
          'subscription_limit',
          'Revocation must preserve the final refusal journal',
        )
      })
      await restoreWindow(backend)
      passed(`real ${profiles[backend].driver} stops on final quota and SQL retains the refusal`)
    }

    await scenario('openai-chatgpt', 'plan-then-text')
    await withTurn('openai-chatgpt', async (turn) => {
      const before = await countRequests('openai-chatgpt')
      const result = await cli.run({
        driver: 'codex',
        key: turn.values.llmApiKey,
        prompt: 'Prepare the synthetic plan, then report completion.',
      })
      assert.equal(result.code, 0, 'Codex plan-then-text did not finish')
      assert.equal((await countRequests('openai-chatgpt')) - before, 2)
      assert.equal(result.lastMessage, 'Synthetic B13 complete.')
      assert.equal(result.events.filter((event) => event.type === 'turn.completed').length, 1)
      await settled(turn, 2)
    })
    await scenario('openai-chatgpt', 'text')
    passed('real Codex completes a plan/tool round followed by final text')

    await withTurn('openai-chatgpt', async (turn) => {
      const valid = bodyFor('openai-chatgpt')
      const before = await countRequests('openai-chatgpt')
      let nested = 'synthetic'
      for (let depth = 0; depth < 70; depth++) nested = [nested]
      const cases = [
        [valid, { 'content-type': 'text/plain' }],
        ['{"invalid":', {}],
        [{ ...valid, model: 'not-the-issued-model' }, {}],
        [{ ...valid, stream: false }, {}],
        [
          {
            ...valid,
            input: [
              {
                type: 'message',
                role: 'user',
                content: [
                  { type: 'input_image', image_url: 'https://synthetic.invalid/pixel.png' },
                ],
              },
            ],
          },
          {},
        ],
        [{ ...valid, input: nested }, {}],
      ]
      for (const [body, headers] of cases)
        assert.equal(
          (await request('openai-chatgpt', turn, body, headers)).status,
          400,
          'Invalid protocol body escaped the gateway',
        )
      for (const path of ['/codex/models', '/codex/wham/usage', '/kimi/v1/search'])
        assert.equal((await request('openai-chatgpt', turn, valid, {}, path)).status, 403)
      assert.equal((await request('kimi-code', turn, bodyFor('kimi-code'))).status, 403)
      assert.equal(await countRequests('openai-chatgpt'), before)
      assert.equal((await calls(turn)).length, 0)

      const generate = async (kind, bytes) => {
        const result = await run(
          'docker',
          ['exec', '-i', cli.containerName, 'node', '--input-type=module', '-e', generatedRequest],
          { input: JSON.stringify({ kind, bytes, key: turn.values.llmApiKey }), timeoutMs: 25_000 },
        )
        return JSON.parse(result.stdout)
      }
      assert.equal(
        (await generate('gzip')).status,
        400,
        'Compressed request bytes must not reach a provider',
      )
      assert.equal(await countRequests('openai-chatgpt'), before)
      // The production JSON/route limit is 16 MiB; 1 MiB is not its rejection boundary.
      assert.equal((await generate('large', 1024 * 1024 + 1024)).status, 200)
      await settled(turn, 1)
      assert.equal(await countRequests('openai-chatgpt'), before + 1)
      const oversized = await generate('large', 16 * 1024 * 1024 + 1024)
      assert.ok(
        oversized.status === 413 || oversized.status === 502 || oversized.transportRejected,
        'A body beyond the gateway limit must fail before provider admission',
      )
      assert.equal(await countRequests('openai-chatgpt'), before + 1)
      assert.equal((await calls(turn)).length, 1)
    })
    await withTurn('kimi-code', async (turn) => {
      const before = await countRequests('kimi-code')
      assert.equal(
        (
          await request('kimi-code', turn, {
            ...bodyFor('kimi-code'),
            tools: [{ type: 'builtin_function', function: { name: 'web_search' } }],
          })
        ).status,
        400,
      )
      assert.equal(await countRequests('kimi-code'), before)
      assert.equal(
        (await request('kimi-code', turn, { ...bodyFor('kimi-code'), stream: false })).status,
        200,
      )
      await settled(turn, 1)
      const received = (await control('state')).requests
        .filter((entry) => entry.path === profiles['kimi-code'].providerPath)
        .at(-1)
      assert.equal(received.body.stream, true)
      assert.equal(received.body.stream_options.include_usage, true)
    })
    passed(
      'protocol/model/path/backend refusals, compressed/large bodies and Kimi streaming normalization',
    )

    const foreignSource = await acquire('openai-chatgpt', { boundSource: '192.0.2.15' })
    try {
      const before = await countRequests('openai-chatgpt')
      assert.equal((await request('openai-chatgpt', foreignSource)).status, 401)
      assert.equal(await countRequests('openai-chatgpt'), before)
      assert.equal((await calls(foreignSource)).length, 0)
    } finally {
      await release(foreignSource)
    }
    passed('a turn key bound to another runner address is rejected before provider admission')

    const direct = await run(
      'docker',
      ['exec', cli.containerName, 'node', '--input-type=module', '-e', networkProbe],
      { timeoutMs: 5000 },
    )
    assert.deepEqual(JSON.parse(direct.stdout), { directIp: false, dnsResolved: false })
    passed('guarded CLI cannot reach an external IP or Docker embedded DNS')

    const client = await task('openai-chatgpt')
    let clearance
    try {
      await db.workspace.update({
        where: { id: client.record.workspaceId },
        data: { dataClass: 'client' },
      })
      await assert.rejects(
        core.call('issue', { ref: client.ref, grant: client.grant }),
        (error) => error.code === 'CROSS_BORDER_NOT_CLEARED',
      )
      assert.equal(await db.llmKey.count({ where: { taskId: client.ref.taskId } }), 0)
      const provider = await db.llmProvider.findUniqueOrThrow({ where: { slug: 'openai-chatgpt' } })
      clearance = await db.crossBorderClearance.create({
        data: {
          providerId: provider.id,
          countries: 'US',
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
      const turn = {
        ...client,
        values: await core.call('issue', { ref: client.ref, grant: client.grant }),
      }
      remember(turn)
      assert.deepEqual(await core.call('recover', { ref: turn.ref }), turn.values)
      await release(turn)
    } finally {
      await db.workspace.update({
        where: { id: client.record.workspaceId },
        data: { dataClass: 'synthetic' },
      })
      if (clearance) await db.crossBorderClearance.delete({ where: { id: clearance.id } })
    }
    passed(
      'client-data issuance fails without clearance and succeeds with an owned synthetic clearance',
    )

    const repeated = await task('openai-chatgpt')
    const duplicates = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        core.call('issue', { ref: repeated.ref, grant: repeated.grant }),
      ),
    )
    const first = duplicates.find((result) => result.status === 'fulfilled')
    if (first) remember({ ...repeated, values: first.value })
    assert.ok(
      duplicates.every((result) => result.status === 'fulfilled'),
      'Concurrent identical issuance must recover one write-once key',
    )
    for (const result of duplicates) assert.deepEqual(result.value, first.value)
    assert.equal(await db.llmKey.count({ where: { taskId: repeated.ref.taskId } }), 1)
    assert.equal(await db.taskAccountBinding.count({ where: { taskId: repeated.ref.taskId } }), 1)
    await release(owned.get(repeated.ref.taskId))

    const independent = await Promise.all([task('openai-chatgpt'), task('openai-chatgpt')])
    const admissions = await Promise.allSettled(
      independent.map((turn) => core.call('issue', { ref: turn.ref, grant: turn.grant })),
    )
    for (let index = 0; index < admissions.length; index++)
      if (admissions[index].status === 'fulfilled')
        remember({
          ...independent[index],
          values: admissions[index].value,
        })
    assert.equal(
      admissions.filter((result) => result.status === 'fulfilled').length,
      1,
      'Codex capacity one must fence concurrent distinct turns',
    )
    const rejected = admissions.find((result) => result.status === 'rejected')
    assert.ok(
      ['SUBSCRIPTION_BUSY', 'SUBSCRIPTION_WAIT'].includes(rejected.reason.code),
      'Capacity contention must be a domain refusal, never a deadlock',
    )
    for (const turn of [...owned.values()]) await release(turn)
    passed(
      'parallel identical issue returns one key; distinct Codex turns serialize without a database deadlock',
    )
  } finally {
    const cleanup = await Promise.allSettled([...owned.values()].map(release))
    await control('scenario', { scenario: 'text' })
    assert.ok(
      cleanup.every((result) => result.status === 'fulfilled'),
      'Protocol turn-key cleanup failed',
    )
  }
}
