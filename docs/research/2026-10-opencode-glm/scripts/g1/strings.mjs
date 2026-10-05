// Point 5 of G1 — read out of the CLI executable (not exercised here): contexts of a pattern.
//   docker run --rm --network none -v <this directory>:/spike:ro --entrypoint node <image> /spike/strings.mjs <name>...
// Names:
//   overflow   the patterns of a context overflow and how an API error is classified as one
//   crash      the variables of the Bun crash reporter (their logic is machine code: see p1crash.mjs)
//   thinking   when the CLI adds the `thinking` field to a request
//   deny       what experimental.continue_loop_on_deny switches
//   tables     the shape of the `permission` and `credential` tables of the CLI's database
// `raw <regex> [before] [after] [max]` prints any other context.
import { readFileSync } from 'node:fs'

const BINARY = process.env.OPENCODE_BINARY ?? '/usr/local/bin/opencode'
const text = readFileSync(BINARY, 'latin1')
const QUERIES = {
  overflow: [
    ['exceeds the context window', 500, 3200, 1],
    ['context_length_exceeded', 700, 1500, 1],
  ],
  crash: [
    ['BUN_ENABLE_CRASH_REPORTING', 120, 200, 3],
    ['BUN_CRASH_REPORT_URL', 120, 200, 3],
    ['DO_NOT_TRACK', 80, 160, 3],
    ['https://bun\\.report', 200, 300, 2],
  ],
  thinking: [['clear_thinking:', 900, 500, 1]],
  deny: [['continue_loop_on_deny', 350, 450, 2]],
  tables: [
    ['"permission",\\{', 100, 900, 1],
    ['"credential",\\{', 100, 700, 1],
    ['Credential\\.(Key|OAuth|Value)"', 500, 400, 1],
    ['PermissionSaved\\.(list|add)"\\)', 200, 900, 1],
  ],
}
function show(pattern, before, after, max) {
  const re = new RegExp(pattern, 'g')
  let match
  let shown = 0
  let last = -1e9
  while ((match = re.exec(text)) && shown < max) {
    if (match.index - last < after) continue
    last = match.index
    shown += 1
    const piece = text
      .slice(Math.max(0, match.index - before), match.index + after)
      .replace(/[^\x20-\x7e\n]/g, '.')
    console.log(`--- /${pattern}/ @${match.index}\n${piece}`)
  }
  console.log(`(${shown} shown of /${pattern}/)`)
}
const [name, ...rest] = process.argv.slice(2)
if (name === 'raw')
  show(rest[0], Number(rest[1] ?? 200), Number(rest[2] ?? 400), Number(rest[3] ?? 6))
else
  for (const query of [name, ...rest])
    for (const [pattern, before, after, max] of QUERIES[query] ?? [])
      show(pattern, before, after, max)
