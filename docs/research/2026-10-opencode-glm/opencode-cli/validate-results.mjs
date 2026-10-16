// Validates the final text of each D run the way extractJsonResult does (strict zod schema of the product).
// Usage: PROBE_OUT=… node validate-results.mjs <scenario>...   (reads $PROBE_OUT/runs/<scenario>/stdout.txt)
import { readFileSync } from 'node:fs'
const { turnResultSchema } = await import(
  new URL('../../../../packages/domain/src/index.ts', import.meta.url)
)
for (const run of process.argv.slice(2)) {
  const lines = readFileSync(`${process.env.PROBE_OUT}/runs/${run}/stdout.txt`, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const last = lines.findLast((row) => row.type === 'text')?.part.text
  let verdict
  try {
    const parsed = turnResultSchema.safeParse(JSON.parse(last.trim()))
    verdict = parsed.success
      ? `valid (change_type=${parsed.data.change_type}, needs_approval=${parsed.data.needs_approval}, risk=${parsed.data.risk}, questions=${parsed.data.questions.length}, files=${JSON.stringify(parsed.data.files_changed)})`
      : `INVALID ${JSON.stringify(parsed.error.issues).slice(0, 300)}`
  } catch (error) {
    verdict = `NOT JSON: ${String(last).slice(0, 120)}`
  }
  console.log(
    run,
    '->',
    verdict,
    `[${last?.length} chars, text events: ${lines.filter((row) => row.type === 'text').length}]`,
  )
}
