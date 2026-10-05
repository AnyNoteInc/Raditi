// node --test docs/research/2026-10-opencode-glm/scripts/g1/needles.test.mjs
// The leak statements of the G1 report rest on this search: it must find a value in every form it names,
// and what the fake recorded must be refused when it holds one. Values are made here, never written down.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { assertNoNeedles, findNeedles, formsOf } from './needles.mjs'

const turnKey = () => `sk-rdt-${randomBytes(32).toString('base64url')}`
const mcpToken = () => `mcp_${randomBytes(32).toString('hex')}`
const around = (bytes, before, after) =>
  Buffer.concat([randomBytes(before), Buffer.from(bytes), randomBytes(after)])
const formsFound = (buffer, value) => findNeedles(buffer, { value }).map((hit) => hit.form)

test('a value is found as it is, in hex and in UTF-16', () => {
  for (const value of [turnKey(), mcpToken()]) {
    assert.deepEqual(formsFound(around(value, 7, 9), value), ['raw'])
    assert.deepEqual(formsFound(Buffer.from(`x${Buffer.from(value).toString('hex')}y`), value), [
      'hex',
    ])
    assert.deepEqual(formsFound(around(Buffer.from(value, 'utf16le'), 3, 3), value), ['utf16le'])
  }
})

test('a value is found in base64 whatever stands before and after it, in both alphabets', () => {
  for (const value of [turnKey(), mcpToken()])
    for (const alphabet of ['base64', 'base64url'])
      for (let before = 0; before < 6; before += 1)
        for (let after = 0; after < 4; after += 1) {
          const encoded = around(value, before, after).toString(alphabet)
          const found = formsFound(Buffer.from(`{"blob":"${encoded}"}`), value)
          assert.equal(found.length, 1, `${alphabet}, ${before} before, ${after} after`)
          assert.match(found[0], /^base64#/)
        }
})

test('a value with characters JSON and a URL escape is found in both escaped forms', () => {
  const value = `p"a\\ss w/ord+${randomBytes(12).toString('hex')}`
  assert.ok(formsOf(value).some((item) => item.form === 'json'))
  assert.ok(formsOf(value).some((item) => item.form === 'url'))
  assert.deepEqual(formsFound(Buffer.from(JSON.stringify({ value })), value), ['json'])
  assert.deepEqual(formsFound(Buffer.from(`?v=${encodeURIComponent(value)}`), value), ['url'])
})

test('a part of a value is found when the whole is not there: cut, wrapped or used as a name', () => {
  for (const value of [turnKey(), mcpToken()]) {
    const cases = {
      'cut by a log': `key=${value.slice(0, 22)}… (truncated)`,
      'wrapped at a line break': `${value.slice(0, 20)}\n${value.slice(20)}`,
      'split by a colour code': `${value.slice(0, 9)}\u001b[0m${value.slice(9)}`,
      'a label of a host name': `${value.slice(-40).toLowerCase()}.exfiltration.test`,
    }
    for (const [name, text] of Object.entries(cases))
      if (name !== 'a label of a host name' || value.startsWith('mcp_'))
        assert.deepEqual(formsFound(Buffer.from(text), value), ['fragment'], name)
    // The whole value is reported once, as before: no fragment next to it.
    assert.deepEqual(formsFound(Buffer.from(`x ${value} y`), value), ['raw'])
    // Fewer characters than a fragment are not a finding: the fixed prefix alone names nothing.
    assert.deepEqual(
      formsFound(Buffer.from(`${value.slice(0, 10)} ${value.slice(-10)}`), value),
      [],
    )
  }
})

test('a text without the value gives nothing', () => {
  const value = turnKey()
  assert.deepEqual(findNeedles(Buffer.from(`${turnKey()} ${mcpToken()}`), { value }), [])
})

test('records that hold a credential in any form are refused, and the message never quotes it', () => {
  const needles = { llm: turnKey(), mcp: mcpToken() }
  const clean = JSON.stringify({ records: [{ request: { headers: { 'content-type': 'x' } } }] })
  assert.doesNotThrow(() => assertNoNeedles(clean, needles, 'records of run a'))
  const cases = {
    raw: needles.mcp,
    hex: Buffer.from(needles.llm).toString('hex'),
    base64: Buffer.from(`Bearer ${needles.llm}`).toString('base64'),
  }
  for (const [form, text] of Object.entries(cases)) {
    let thrown
    try {
      assertNoNeedles(JSON.stringify({ records: [{ body: { note: text } }] }), needles, 'records')
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown, `${form} must be refused`)
    assert.match(thrown.message, /^records holds a credential of the stand: (llm|mcp) \(/)
    for (const value of Object.values(needles))
      assert.equal(findNeedles(Buffer.from(thrown.message), { value }).length, 0)
  }
})
