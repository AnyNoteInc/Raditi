import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import type { ExecChunk, Sandbox, SandboxSpec } from '@repo/domain'
import Docker from 'dockerode'
import { afterEach, describe, expect, it } from 'vitest'

import { createDockerSandboxProvider } from './docker.ts'

// Explicit opt-in. Only containers created by this suite are removed; never pull images.
const image = process.env.RADITI_DOCKER_TEST_IMAGE
const socketPath = process.env.SANDBOX_DOCKER_SOCKET ?? '/var/run/docker.sock'
const runtime = process.env.SANDBOX_RUNTIME === 'runsc' ? 'runsc' : 'runc'
const client = new Docker({ socketPath })
const provider = () =>
  createDockerSandboxProvider({ runtime, socketPath, imagePrefix: 'raditi/agent' })
const owned: Sandbox[] = []
const spawn = async (patch: Partial<SandboxSpec> = {}) => {
  const unique = randomBytes(8).toString('hex')
  const sandbox = await provider().create({
    image: image!,
    labels: {
      workspaceId: 'integration',
      siteId: unique,
      taskId: unique,
      sessionId: unique,
      turn: 1,
      leaseEpoch: 17,
    },
    runtime,
    resources: { cpu: 1, memoryMiB: 2048, pids: 128 },
    user: { uid: 10001, gid: 10001 },
    env: {},
    secrets: [],
    network: { mode: 'none' },
    hardTimeoutMs: 60_000,
    ...patch,
  })
  owned.push(sandbox)
  return sandbox
}
const collect = async (output: AsyncIterable<ExecChunk>) => {
  const out = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
  for await (const chunk of output) out[chunk.stream].push(Buffer.from(chunk.data))
  return { stdout: Buffer.concat(out.stdout), stderr: Buffer.concat(out.stderr) }
}
const command = async (sandbox: Sandbox, source: string) => {
  const exec = await sandbox.exec({
    argv: ['/usr/local/bin/node', '-e', source],
    timeoutMs: 10_000,
  })
  const output = await collect(exec.output())
  expect(await exec.wait()).toEqual({ code: 0, reason: 'exited' })
  return output
}

describe.skipIf(!image)('real Docker sandbox provider', () => {
  afterEach(async () => {
    await Promise.all(owned.splice(0).map((sandbox) => sandbox.destroy('completed')))
  })

  it('starts an immutable, bounded, nonroot container and recovers exact labels', async () => {
    const sandbox = await spawn({
      env: {
        NODE_OPTIONS: '--require=/workspace/untrusted.cjs',
        LD_PRELOAD: '/workspace/untrusted.so',
      },
    })
    const info = await client.getContainer(sandbox.id).inspect()
    expect(info.Config.User).toBe('10001:10001')
    expect(info.HostConfig.ReadonlyRootfs).toBe(true)
    expect(info.HostConfig.CapDrop).toEqual(['ALL'])
    expect(info.HostConfig.NetworkMode).toBe('none')
    expect(info.HostConfig.MemorySwap).toBe(info.HostConfig.Memory)
    const output = await command(
      sandbox,
      "const fs=require('fs'); process.stdout.write(JSON.stringify({uid:process.getuid(), status:fs.readFileSync('/proc/self/status','utf8')})); try { fs.writeFileSync('/usr/local/lib/raditi/changed','x'); process.exit(9) } catch {}",
    )
    const status = JSON.parse(output.stdout.toString()) as { uid: number; status: string }
    expect(status.uid).toBe(10001)
    expect(status.status).toMatch(/NoNewPrivs:\s+1/)
    expect(status.status).toMatch(/CapEff:\s+0+\n/)
    await command(
      sandbox,
      `const fs=require('fs');const p='/run/raditi/control/keepalive.json';const original=fs.readFileSync(p);for(const op of [()=>fs.writeFileSync(p,'{}'),()=>fs.unlinkSync(p),()=>fs.chmodSync(p,0o666)]){let denied=false;try{op()}catch{denied=true}if(!denied)process.exit(9)}if(!fs.readFileSync(p).equals(original))process.exit(10)`,
    )
    expect((await provider().get(sandbox.id))!.labels).toEqual(sandbox.labels)
    await (await provider().get(sandbox.id))!.quiesce()
    expect(await provider().list({ taskId: sandbox.labels.taskId, leaseEpoch: 17 })).toMatchObject([
      { id: sandbox.id, labels: sandbox.labels },
    ])
  }, 30_000)

  it('roundtrips binary files through stdin and refuses symlink traversal and hostile paths', async () => {
    const sandbox = await spawn({
      secrets: [{ path: '/run/raditi/secrets/synthetic', value: 'synthetic-test-value' }],
    })
    const bytes = Buffer.from([0, 255, 1, 13, 10, 128])
    await sandbox.fs.write('/workspace/inbox/nested/binary', bytes, { mode: 0o640 })
    expect(await sandbox.fs.read('/workspace/inbox/nested/binary')).toEqual(bytes)
    expect(await sandbox.fs.list('/workspace', { recursive: true, maxEntries: 20 })).toContainEqual(
      { path: '/workspace/inbox/nested/binary', type: 'file', size: bytes.length },
    )
    await command(
      sandbox,
      "const fs=require('fs'); fs.symlinkSync('/run/raditi/secrets','/workspace/link'); fs.symlinkSync('/run/raditi/secrets/synthetic','/workspace/direct')",
    )
    for (const path of [
      '/workspace/link/synthetic',
      '/workspace/direct',
      '/workspace/../run/raditi/secrets/synthetic',
    ])
      await expect(sandbox.fs.read(path)).rejects.toThrow()
    await expect(sandbox.fs.write('/workspace/link/synthetic', bytes)).rejects.toThrow()
    await expect(
      sandbox.fs.read('/workspace/inbox/nested/binary', { maxBytes: 2 }),
    ).rejects.toThrow()
    await sandbox.fs.remove('/workspace/inbox/nested', { recursive: true })
    await expect(sandbox.fs.read('/workspace/inbox/nested/binary')).rejects.toThrow()
    expect(Buffer.from(await sandbox.fs.read('/run/raditi/secrets/synthetic')).toString()).toBe(
      'synthetic-test-value',
    )
  }, 30_000)

  it('replays exact binary stdout/stderr after detaching and constructing a new provider', async () => {
    const sandbox = await spawn()
    const stdin = async function* () {
      const reusable = Buffer.from([0, 255, 42])
      yield reusable
      reusable[2] = 43
      yield reusable
    }
    const exec = await sandbox.exec({
      argv: [
        '/usr/local/bin/node',
        '-e',
        "process.stdout.write(Buffer.from([1,2])); process.stderr.write(Buffer.from([3,255])); const b=[]; process.stdin.on('data',x=>b.push(x)); process.stdin.on('end',()=>setTimeout(()=>{process.stdout.write(Buffer.concat(b));process.stderr.write(Buffer.from([0,4]))},300))",
      ],
      stdin: stdin(),
      timeoutMs: 5000,
    })
    const iterator = exec.output()[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    const firstChunk: ExecChunk = first.value
    const cursor = { stdout: 0, stderr: 0 }
    cursor[firstChunk.stream] += firstChunk.data.length
    await iterator.return?.()
    const recovered = (await provider().get(sandbox.id))!
    const attached = await recovered.attach(exec.id, cursor)
    const rest = await collect(attached.output())
    const total = { stdout: rest.stdout, stderr: rest.stderr }
    total[firstChunk.stream] = Buffer.concat([
      Buffer.from(firstChunk.data),
      total[firstChunk.stream],
    ])
    expect(total.stdout).toEqual(Buffer.from([1, 2, 0, 255, 42, 0, 255, 43]))
    expect(total.stderr).toEqual(Buffer.from([3, 255, 0, 4]))
    expect(await attached.wait()).toEqual({ code: 0, reason: 'exited' })
  }, 30_000)

  it('handles missing executables and command timeout without hanging', async () => {
    const sandbox = await spawn()
    for (let iteration = 0; iteration < 10; iteration++) {
      const fast = await sandbox.exec({ argv: ['/usr/bin/printf', 'native-tail'], timeoutMs: 2000 })
      expect((await collect(fast.output())).stdout.toString()).toBe('native-tail')
      expect(await fast.wait()).toEqual({ code: 0, reason: 'exited' })
    }
    const git = await sandbox.exec({ argv: ['/usr/bin/git', '--version'], timeoutMs: 2000 })
    expect((await collect(git.output())).stdout.toString()).toMatch(/^git version /)
    expect(await git.wait()).toEqual({ code: 0, reason: 'exited' })
    const missing = await sandbox.exec({ argv: ['/no-such-command'], timeoutMs: 2000 })
    expect(await missing.wait()).toMatchObject({ reason: 'lost' })
    const timeout = await sandbox.exec({
      argv: ['/usr/local/bin/node', '-e', 'setInterval(()=>{},1000)'],
      timeoutMs: 300,
    })
    expect(await timeout.wait()).toMatchObject({ reason: 'timeout' })
  }, 20_000)

  it('cancels process groups and escaped descendants, then permits a clean quiescent snapshot phase', async () => {
    const sandbox = await spawn()
    const controller = new AbortController()
    const child =
      "setTimeout(()=>require('fs').writeFileSync('/workspace/escaped-marker','bad'),1500);setInterval(()=>{},1000)"
    const source = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref();process.stdout.write('ready');setInterval(()=>{},1000)`
    const exec = await sandbox.exec({
      argv: ['/usr/local/bin/node', '-e', source],
      timeoutMs: 5000,
      signal: controller.signal,
    })
    const iterator = exec.output()[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    await iterator.return?.()
    controller.abort()
    expect(await exec.wait()).toMatchObject({ reason: 'cancelled' })
    await sandbox.quiesce()
    await delay(1600)
    await expect(sandbox.fs.read('/workspace/escaped-marker')).rejects.toThrow()
    await sandbox.fs.write('/workspace/after', Buffer.from('ok'))
    expect(Buffer.from(await sandbox.fs.read('/workspace/after')).toString()).toBe('ok')
  }, 20_000)

  it('quiesces a detached child even after its parent reported success', async () => {
    const sandbox = await spawn()
    const child =
      "setTimeout(()=>require('fs').writeFileSync('/workspace/late-marker','bad'),1000);setInterval(()=>{},1000)"
    await command(
      sandbox,
      `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref()`,
    )
    await sandbox.quiesce()
    await delay(1100)
    await expect(sandbox.fs.read('/workspace/late-marker')).rejects.toThrow()
  }, 15_000)

  it('does not exempt an orphan that forges the keepalive command line', async () => {
    const sandbox = await spawn()
    const child = `require('fs').writeFileSync('/workspace/spoof-pid',String(process.pid));setTimeout(()=>require('fs').writeFileSync('/workspace/spoof-marker','bad'),1500);setInterval(()=>{},1000)`
    await sandbox.fs.write('/workspace/repo/infinity', Buffer.from(child))
    await command(
      sandbox,
      `require('child_process').spawn(process.execPath,['infinity'],{argv0:'sleep',cwd:'/workspace/repo',detached:true,stdio:'ignore'}).unref()`,
    )
    await delay(100)
    const spoof = await command(
      sandbox,
      `const fs=require('fs');const pid=fs.readFileSync('/workspace/spoof-pid','utf8');process.stdout.write(fs.readFileSync('/proc/'+pid+'/cmdline'))`,
    )
    expect(spoof.stdout.toString()).toMatch(/^sleep\0infinity\0/)
    await sandbox.quiesce()
    await delay(1600)
    await expect(sandbox.fs.read('/workspace/spoof-marker')).rejects.toThrow()
    await sandbox.fs.write('/workspace/after-spoof', Buffer.from('ok'))
  }, 15_000)

  it('fails a noisy process at the bounded spool limit', async () => {
    const sandbox = await spawn()
    const exec = await sandbox.exec({
      argv: [
        '/usr/local/bin/node',
        '-e',
        "const b=Buffer.alloc(1024*1024,65); (async()=>{for(let i=0;i<80;i++){if(!process.stdout.write(b))await new Promise(r=>process.stdout.once('drain',r))}})()",
      ],
      timeoutMs: 10_000,
    })
    expect(await exec.wait()).toMatchObject({ reason: 'lost' })
    const result = await command(
      sandbox,
      `process.stdout.write(String(require('fs').statSync('/run/raditi/exec/${exec.id.split('.')[0]}/stdout').size))`,
    )
    expect(Number(result.stdout.toString())).toBeLessThanOrEqual(64 * 1024 * 1024)
  }, 20_000)

  it('lets a standalone host process exit naturally after exec and destroy', async () => {
    const sandbox = await spawn()
    const entry = new URL('./docker.ts', import.meta.url).href
    const source = `
      import { createDockerSandboxProvider } from ${JSON.stringify(entry)};
      const provider = createDockerSandboxProvider(${JSON.stringify({ runtime, socketPath, imagePrefix: 'raditi/agent' })});
      const sandbox = await provider.get(${JSON.stringify(sandbox.id)});
      if (!sandbox) throw new Error('Missing owned fixture');
      try {
        for (let i = 0; i < 5; i++) {
          const exec = await sandbox.exec({ argv: ['/usr/bin/printf', 'shutdown'], timeoutMs: 2000 });
          let output = '';
          for await (const chunk of exec.output()) output += Buffer.from(chunk.data).toString();
          if (output !== 'shutdown' || (await exec.wait()).code !== 0) throw new Error('Lost output');
        }
      } finally { await sandbox.destroy('completed'); }
      process.stdout.write('shutdown-complete');
    `
    const result = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', source],
      {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    )
    expect(result.stdout).toBe('shutdown-complete')
  }, 20_000)
})
