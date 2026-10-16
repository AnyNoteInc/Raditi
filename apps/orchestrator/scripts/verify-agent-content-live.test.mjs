/* global URL */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import {
  CONTENT_ATTEMPTS,
  CONTENT_TURN_CALLS,
  liveContentPages,
  publishedMarkerProblem,
} from './verify-agent-content-live.mjs'
import { LIVE_LIMITS } from '../../../infra/dev/llm-verify/live.mjs'

const source = (name) => readFile(new URL(`./${name}`, import.meta.url), 'utf8')

test('a privacy marker on the public page after an applied write is the fault of the platform', () => {
  const marker = '[[raditi:email:0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d]]'
  assert.equal(publishedMarkerProblem('<p>New text. Write to us: a@example.test</p>', 1), null)
  assert.match(publishedMarkerProblem(`<p>New text. Write to us: ${marker}</p>`, 1), /marker/)
  assert.match(publishedMarkerProblem('<p>cut [[raditi:email:</p>', 2), /marker/)
  // Without an applied write the page is what the fixture made it: nothing of the turn's.
  assert.equal(publishedMarkerProblem(`<p>${marker}</p>`, 0), null)
})

test('the live flow has attempts and pages of its own, whatever CLIs the stand has rows for', async () => {
  assert.equal(CONTENT_ATTEMPTS, 3)
  assert.deepEqual(liveContentPages(), ['attempt-1', 'attempt-2', 'attempt-3'])
  // Every attempt is covered by the cap of the run: the import, the first probe of the role,
  // the attempts at the ceiling of their keys and the last reading of the quota.
  assert.ok(1 + 1 + CONTENT_ATTEMPTS * CONTENT_TURN_CALLS + 1 <= LIVE_LIMITS.content.requests)
  const live = await source('verify-agent-content-live.mjs')
  assert.doesNotMatch(live, /CONTENT_DRIVERS/)
  const main = await source('verify-agent-content.mjs')
  // One page a CLI in the deterministic pass, one page an attempt in the live one.
  assert.match(
    main,
    /prepareSite\(\s*\{ wp, compose, url \},\s*live \? liveContentPages\(\) : CONTENT_DRIVERS,?\s*\)/,
  )
})

test('what depends on the model does not decide a live content run', async () => {
  const live = await source('verify-agent-content-live.mjs')
  assert.doesNotMatch(live, /assert\.ok\((edits|results) > 0/)
  // The hard check of the page is made in every attempt, before the outcome is judged.
  assert.ok(
    live.indexOf('publishedMarkerProblem(html, applied)') > 0 &&
      live.indexOf('publishedMarkerProblem(html, applied)') < live.indexOf('const edited ='),
  )
  // A check that cannot fail is no check: the journal key is unique in the database.
  assert.doesNotMatch(live, /two journal rows for one key/)
})

test('both live flows stop a turn at a refusal of a guard, and search before they clean up after a failure', async () => {
  const content = await source('verify-agent-content-live.mjs')
  assert.match(
    content,
    /await live\.watched\(\s*\(\) => runCli\(turn\),\s*\(\) => cli\.close\(\),?\s*\)/,
  )
  const gateway = await source('verify-llm-live.mjs')
  assert.match(gateway, /await live\.watched\(\s*\(\) => cli\.runPrepared\(/)
  assert.doesNotMatch(`${content}${gateway}`, /setInterval/)
  // The failure path of each stand calls the search before its cleanup starts.
  assert.ok(
    gateway.indexOf('await live.afterFailure({') <
      gateway.indexOf('} finally {\n    // The OpenBao container'),
  )
  const main = await source('verify-agent-content.mjs')
  const failed = main.indexOf('await live.afterFailure({')
  assert.ok(failed > 0 && failed < main.indexOf('const cleanup = ['))
  // No stand hands the output of a role to a search chunk by chunk.
  for (const text of [
    main,
    gateway,
    await source('verify-llm-live-run.mjs'),
    await source('verify-llm-gateway.mjs'),
  ])
    assert.doesNotMatch(text, /flatMap\(\(worker\) => worker\.logs\)|texts: logs\.flat\(\)/)
})
