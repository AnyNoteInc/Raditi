import { describe, expect, it } from 'vitest'

import { agentOutputLimits, clipCommandOutput, COMMAND_OUTPUT_GAP } from './agent-driver.ts'

describe('what a command printed, clipped', () => {
  it('keeps an output that fits as it is', () => {
    expect(clipCommandOutput('ok\n')).toEqual({ output: 'ok\n', outputCut: false })
    const full = 'x'.repeat(agentOutputLimits.commandOutput)
    expect(clipCommandOutput(full)).toEqual({ output: full, outputCut: false })
  })

  it('keeps three quarters of the start and a quarter of the end of a long one', () => {
    const { output, outputCut } = clipCommandOutput(`${'н'.repeat(10_000)}ошибка`)
    expect(outputCut).toBe(true)
    expect(output.length).toBeLessThanOrEqual(agentOutputLimits.commandOutput)
    const [head, tail] = output.split(COMMAND_OUTPUT_GAP)
    expect(head!.length).toBeGreaterThan(tail!.length * 2)
    expect(tail!.endsWith('ошибка')).toBe(true)
  })

  it('never splits a pair of surrogates and stays within the limit', () => {
    const { output } = clipCommandOutput('😀'.repeat(5000))
    expect(output.length).toBeLessThanOrEqual(agentOutputLimits.commandOutput)
    expect(output.isWellFormed()).toBe(true)
  })
})
