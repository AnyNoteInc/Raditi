// Point 2 of G1, added by the review: the one-shot delivery keeps the keys out of files and environments, but
// a CLI that listened on a loopback port would hand its resolved configuration to any command of the model.
// One turn: the model's command lists what listens in the container and asks whatever answers.
import {
  AGENTS_MARKER,
  config,
  newTokens,
  resultStep,
  save,
  sha256,
  summariseRecords,
  toolStep,
} from './lib.mjs'

export async function p2ports(stand) {
  const tokens = newTokens()
  await stand.scenario('p2-ports', {
    llmKeySha256: sha256(tokens.llm),
    mcpTokenSha256: sha256(tokens.mcp),
    steps: [
      toolStep([
        {
          name: 'bash',
          arguments: {
            command: `node /spike/in/listeners.mjs llm=${sha256(tokens.llm)} mcp=${sha256(tokens.mcp)}`,
            description: 'look for listeners',
            timeout: 100_000,
          },
        },
      ]),
      resultStep(),
    ],
  })
  const cli = await stand.cli('p2-ports')
  await cli.stage({
    configText: JSON.stringify(config('p2-ports'), null, 2),
    agentsMd: `${AGENTS_MARKER}\n`,
    secrets: tokens,
  })
  const turn = await cli.turn({
    prompt: 'Client request: look around',
    needles: tokens,
    timeoutS: 180,
  })
  const records = await stand.records('p2-ports')
  save(stand, 'p2-ports', 'records.json', records)
  await cli.remove()
  const check = turn.tools.find((tool) => tool.tool === 'bash')
  let seen
  try {
    seen = JSON.parse(check?.output ?? '')
  } catch {
    seen = { unparsed: check?.output?.slice(0, 600), status: check?.status }
  }
  return {
    exit: turn.exit,
    steps: turn.steps.map((step) => step.reason),
    requests: summariseRecords(records).llmRequests,
    seenByTheModel: seen,
    hits: [...turn.outputHits, ...turn.left.hits],
  }
}
