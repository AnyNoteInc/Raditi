// infra/dev/litellm.config.yaml must stay in step with the seed: the orchestrator calls a model by
// llm_models.slug, so model_name equals the slug; model_info costs are the seeded RUB prices per
// token (per 1M / 1e6), used only for LiteLLM's per-turn key budget.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { Prisma } from '../../src/generated/prisma/client.ts'
import { llmModelSeeds } from './data.ts'

const configUrl = new URL('../../../../infra/dev/litellm.config.yaml', import.meta.url)

interface ModelEntry {
  modelName: string
  modelInfo: Record<string, string>
}

/** Just enough YAML for model_list: `- model_name: x` opens an entry, model_info holds scalars. */
function parseModelList(yaml: string): ModelEntry[] {
  const entries: ModelEntry[] = []
  let entry: ModelEntry | undefined
  let inModelInfo = false
  for (const line of yaml.split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue
    const start = /^ {2}- model_name: (\S+)$/.exec(line)
    if (start?.[1]) {
      entry = { modelName: start[1], modelInfo: {} }
      entries.push(entry)
      inModelInfo = false
    } else if (!line.startsWith(' ')) {
      entry = undefined
    } else if (entry && /^ {4}\S/.test(line)) {
      inModelInfo = line === '    model_info:'
    } else if (entry && inModelInfo) {
      const field = /^ {6}(\w+): (\S+)$/.exec(line)
      if (field?.[1] && field[2]) entry.modelInfo[field[1]] = field[2]
    }
  }
  return entries
}

/** RUB per token in the config as RUB per 1M, exactly. */
const per1m = (perToken: string | undefined) =>
  perToken === undefined ? undefined : new Prisma.Decimal(perToken).mul(1_000_000).toString()

const normalized = (value: string | null) =>
  value === null ? undefined : new Prisma.Decimal(value).toString()

describe('infra/dev/litellm.config.yaml', () => {
  const entries = parseModelList(readFileSync(configUrl, 'utf8'))

  it('names every model by its seeded slug, once', () => {
    expect(entries.map((e) => e.modelName)).toEqual(llmModelSeeds.map((m) => m.slug))
  })

  it('prices every model at the seeded RUB per 1M / 1e6, cache read only where seeded', () => {
    for (const { slug, price } of llmModelSeeds) {
      const info = entries.find((e) => e.modelName === slug)?.modelInfo ?? {}
      expect(
        {
          input: per1m(info.input_cost_per_token),
          cacheRead: per1m(info.cache_read_input_token_cost),
          cacheWrite: per1m(info.cache_creation_input_token_cost),
          output: per1m(info.output_cost_per_token),
        },
        slug,
      ).toEqual({
        input: normalized(price.inputPer1m),
        cacheRead: normalized(price.cacheReadPer1m),
        cacheWrite: normalized(price.cacheWritePer1m),
        output: normalized(price.outputPer1m),
      })
    }
  })
})

describe('parseModelList', () => {
  it('reads model_info scalars and ignores comments and other keys', () => {
    const yaml = [
      '# header',
      'model_list:',
      '  # comment',
      '  - model_name: a',
      '    litellm_params:',
      '      model: openai/<id>',
      '    model_info:',
      '      input_cost_per_token: 0.0002',
      '',
      '  - model_name: b',
      '    model_info:',
      '      output_cost_per_token: 0.000061',
      'general_settings:',
      '  master_key: os.environ/X',
    ].join('\n')
    expect(parseModelList(yaml)).toEqual([
      { modelName: 'a', modelInfo: { input_cost_per_token: '0.0002' } },
      { modelName: 'b', modelInfo: { output_cost_per_token: '0.000061' } },
    ])
  })
})
