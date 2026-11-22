import { describe, expect, it } from 'vitest'

import { artifactIdOf, parseArtifactsArguments, runArtifactsCommand } from './operator-cli.ts'

// The operator's commands of artifacts (docs/plan/88-artifacts.md, Ар57, slice 88.23).

const id = '019f1a21-1800-7f00-8abc-0000000000a1'

describe('artifacts:take-down and artifacts:return', () => {
  it('reads an artifact by its address in the cabinet or by its id', () => {
    expect(artifactIdOf(`https://raditi.ru/artifacts/${id}`)).toBe(id)
    expect(artifactIdOf(`https://raditi.ru/artifacts/${id.toUpperCase()}/`)).toBe(id)
    expect(artifactIdOf(id)).toBe(id)
  })

  it('refuses an address that is no artifact, and a link /a#… until links come', () => {
    for (const address of [
      'raditi.ru/artifacts',
      `ftp://raditi.ru/artifacts/${id}`,
      `https://user:x@raditi.ru/artifacts/${id}`,
      'https://raditi.ru/artifacts/not-an-id',
      `https://raditi.ru/chats/${id}`,
    ])
      expect(() => artifactIdOf(address), address).toThrow('Адрес артефакта не распознан')
    expect(() => artifactIdOf('https://raditi.ru/a#abc')).toThrow('/a#')
  })

  it('takes the address, a reason and an operator, nothing else', () => {
    expect(parseArtifactsArguments(['--', id, '--reason', 'Жалоба №1'])).toEqual({
      help: false,
      value: { address: id, reason: 'Жалоба №1' },
    })
    expect(() => parseArtifactsArguments([id])).toThrow('команды артефактов')
    expect(() => parseArtifactsArguments([id, '--reason', 'a', '--extra', 'b'])).toThrow()
  })

  it('asks for the environment before it connects anywhere', async () => {
    await expect(
      runArtifactsCommand('take-down', [id, '--reason', 'Жалоба'], {}, () => {}),
    ).rejects.toThrow('APP_ENV')
    let help = ''
    await runArtifactsCommand('return', ['--help'], {}, (text) => (help += text))
    expect(help).toContain('artifacts:return')
  })
})
