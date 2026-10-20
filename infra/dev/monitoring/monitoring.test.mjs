// The local monitoring contract: what Prometheus scrapes against what `pnpm dev` serves. Text only.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const prometheus = read('./prometheus.yml')
const rules = read('./rules/raditi.yml')
const dashboard = JSON.parse(read('./grafana/dashboards/raditi-overview.json'))
const example = read('../../../.env.example')
const setting = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(example)?.[1] ?? ''
// One scrape job, from its name to the next list item of the same depth.
const job = (name) =>
  new RegExp(`^  - job_name: ${name}\\n(?:(?:    .*)?\\n)+`, 'm').exec(prometheus)?.[0] ?? ''

test('the subscription gateway of pnpm dev is scraped on its own port', () => {
  // The llm app keeps its own registry: nothing of it shows on the port of core.
  const target = `host.docker.internal:${setting('LLM_GATEWAY_PORT')}`
  assert.equal(target, 'host.docker.internal:8084')
  // The gateway answers only for the Host names it lists.
  assert.ok(setting('LLM_GATEWAY_HOSTS').split(',').includes(target))
  const llm = job('llm')
  assert.ok(llm, 'prometheus.yml has the llm job')
  assert.match(llm, /^ {4}metrics_path: \/metrics$/m)
  assert.ok(llm.includes(`authorization: { credentials: ${setting('METRICS_TOKEN')} }`))
  assert.ok(llm.includes(`targets: ['${target}']`))
  // A required target: the role is part of the default `pnpm dev`.
  assert.doesNotMatch(llm, /compose_profile/)
})

test('the gateway health is probed apart from the required endpoints', () => {
  const health = 'http://host.docker.internal:8084/health'
  const probes = job('blackbox-http')
  const groups = probes.split(/^ {6}- targets:/m).slice(1)
  const own = groups.filter((group) => group.includes(health))
  assert.equal(own.length, 1, 'one target group probes the gateway health')
  // In dev the llm app may not be running, and its health is degraded (503)
  // with a proxy configured and no channel or with a provider out of reach on the direct path
  // (without a proxy it answers 200 since G4): under a profile label the probe stays out of
  // EndpointDown and of the required panel.
  assert.match(own[0], /^ {8}labels: \{ compose_profile: llm \}$/m)
  assert.match(rules, /expr: probe_success\{compose_profile=""\} == 0/)
})

test('the gateway has an alert and a panel, and both name metrics the gateway exports', () => {
  const server = read('../../../apps/llm/src/gateway/server.ts')
  const [, counters] = /#counters = \{\n([^}]+)\}/.exec(server) ?? []
  assert.ok(counters, 'the counters of the gateway are found in server.ts')
  const exported = new Set([
    ...[...counters.matchAll(/^\s*([A-Za-z]+): 0,$/gm)].map(
      ([, key]) =>
        `raditi_llm_${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_total`,
    ),
    ...[...server.matchAll(/name: '(raditi_llm_[a-z_]+)'/g)].map(([, name]) => name),
  ])
  assert.ok(exported.has('raditi_llm_requests_total') && exported.has('raditi_llm_active_requests'))
  const used = (text) => [...text.matchAll(/raditi_llm_[a-z_]+/g)].map(([name]) => name)
  const alerts = used(rules)
  const panels = used(
    dashboard.panels.flatMap((panel) => panel.targets.map((target) => target.expr)).join('\n'),
  )
  // Usage that could not be written is money: the one gateway alert that needs no pool (M9).
  assert.ok(alerts.includes('raditi_llm_persistence_failed_total'))
  assert.ok(panels.includes('raditi_llm_requests_total'))
  assert.ok(panels.includes('raditi_llm_refusals_total'))
  for (const name of [...alerts, ...panels]) assert.ok(exported.has(name), name)
  const ids = dashboard.panels.map((panel) => panel.id)
  assert.equal(new Set(ids).size, ids.length)
})
