import assert from 'node:assert/strict'
import { test } from 'node:test'

import { replayProblem } from './verify-agent-content-turns.mjs'

// What a CLI hands the model for the three calls of the edit turn. The pinned OpenCode passes
// the text of the role's result as it is (the stand's synthetic provider recorded it on
// 09.10.2026); a CLI may also put a line of its own before the text or wrap it in a structure.
const SNAPSHOT = '03ef56d5-cb21-4141-961e-132cc1156159'
const stored = { objectRef: 'page:10', snapshotId: SNAPSHOT }
const page = '{"content":"<p>synthetic</p>","excerpt":"","objectRef":"page:10","title":"Synthetic"}'
const answer = `{"objectRef":"page:10","snapshotId":"${SNAPSHOT}","updated":true}`
// The role refuses a call after admission with HTTP 200 as well: a tool result with a code alone.
const refusal = (code) => JSON.stringify({ code })
const forms = {
  opencode: (texts) => texts,
  prefixed: (texts) => texts.map((text, index) => `Wall time: 0.0${index + 1}3 seconds\n${text}`),
  wrapped: (texts) =>
    texts.map((text, index) => [
      { type: 'input_text', text: `Script completed\nWall time 0.${index} seconds\nOutput:\n` },
      { type: 'input_text', text: JSON.stringify({ content: [{ type: 'text', text }] }) },
    ]),
}

test('the write and its repeat were answered from the journal row, whatever the CLI wraps them in', () => {
  for (const [cli, form] of Object.entries(forms)) {
    assert.equal(replayProblem(form([page, answer, answer]), stored), null, cli)
    // The repeat refused at HTTP 200 — a replay that failed, a write still in flight — is told
    // from the stored answer: only that names the snapshot of the row.
    for (const code of ['CONTENT_CALL_REJECTED', 'MCP_CALL_IN_FLIGHT'])
      assert.equal(
        replayProblem(form([page, answer, refusal(code)]), stored),
        'the repeat of the write was not answered from the journal row',
        `${cli} ${code}`,
      )
    assert.equal(
      replayProblem(form([page, refusal('CONTENT_CONFLICT'), answer]), stored),
      'the write was not answered from the journal row',
      cli,
    )
    // The answer of another row is not the answer of this one.
    assert.equal(
      replayProblem(
        form([page, answer, answer.replace(SNAPSHOT, SNAPSHOT.replace('0', '1'))]),
        stored,
      ),
      'the repeat of the write was not answered from the journal row',
      cli,
    )
    // A call the model was told nothing about, or one more than the scenario has.
    for (const outputs of [[page, answer], [page, answer, answer, answer], []])
      assert.equal(
        replayProblem(form(outputs), stored),
        `${outputs.length} tool outputs instead of the read, the write and its repeat`,
        cli,
      )
  }
})

test('a CLI that hands the model the text of the role is held to the stored answer word for word', () => {
  const verbatim = { verbatim: true }
  assert.equal(replayProblem([page, answer, answer], stored, verbatim), null)
  // The looser look comes first: a refusal is named as one.
  assert.equal(
    replayProblem([page, answer, refusal('CONTENT_CALL_REJECTED')], stored, verbatim),
    'the repeat of the write was not answered from the journal row',
  )
  // The snapshot of the row with anything else beside it is not the answer the row stores.
  assert.equal(
    replayProblem([page, answer, answer.replace('true', 'false')], stored, verbatim),
    'the repeat of the write was answered differently from the write',
  )
  const other = answer.replace('page:10', 'page:11')
  assert.equal(
    replayProblem([page, other, other], stored, verbatim),
    'the repeat of the write did not get the stored answer of the journal row',
  )
  const extra = answer.replace('}', ',"code":"CONTENT_CONFLICT"}')
  assert.equal(
    replayProblem([page, extra, extra], stored, verbatim),
    'the repeat of the write did not get the stored answer of the journal row',
  )
  const wrapped = forms.prefixed([page, answer, answer]).fill(`Wall time\n${answer}`, 1)
  assert.equal(
    replayProblem(wrapped, stored, verbatim),
    'the repeat of the write did not get the stored answer of the journal row',
  )
  // Without the word-for-word look the same outputs pass: that look is for a wrapping CLI.
  for (const outputs of [[page, other, other], [page, extra, extra], wrapped])
    assert.equal(replayProblem(outputs, stored), null)
})
