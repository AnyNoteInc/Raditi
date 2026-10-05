// Extracts one provider object of the embedded models catalogue as text and as parsed JS.
import { readFileSync } from 'node:fs'
const B = '/usr/local/lib/raditi/opencode-cli/node_modules/opencode-linux-arm64/bin/opencode'
const text = readFileSync(B, 'latin1')
for (const id of process.argv.slice(2)) {
  const start = text.indexOf(`"${id}":{id:"${id}"`)
  if (start < 0) {
    console.log(`${id}: not found`)
    continue
  }
  let i = text.indexOf('{', start),
    depth = 0,
    inString = false
  const open = i
  for (; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) break
    }
  }
  const source = text.slice(open, i + 1)
  const value = Function(`return (${source})`)()
  const models = Object.fromEntries(
    Object.entries(value.models).map(([name, m]) => [
      name,
      {
        reasoning: m.reasoning,
        reasoning_options: m.reasoning_options,
        interleaved: m.interleaved,
        tool_call: m.tool_call,
        structured_output: m.structured_output,
        temperature: m.temperature,
        limit: m.limit,
        cost: m.cost,
        modalities: m.modalities?.input,
        status: m.status,
        release_date: m.release_date,
      },
    ]),
  )
  console.log(
    JSON.stringify(
      {
        id: value.id,
        env: value.env,
        npm: value.npm,
        api: value.api,
        name: value.name,
        doc: value.doc,
        modelCount: Object.keys(value.models).length,
        models,
      },
      null,
      1,
    ),
  )
}
