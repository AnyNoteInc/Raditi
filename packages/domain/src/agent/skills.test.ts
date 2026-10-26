import { describe, expect, it } from 'vitest'

import {
  agentSkillNameSchema,
  agentSkillUrlSchema,
  CONTEXT7_MCP_URL,
  parseAgentSkillUrl,
  turnSkillsOf,
  turnSkillsSchema,
} from './skills.ts'

describe('agent skills', () => {
  it('gives a site the platform skills unless a row turns one off', () => {
    expect(turnSkillsOf([])).toEqual([
      { name: 'context7', kind: 'remote', url: CONTEXT7_MCP_URL },
      { name: 'playwright', kind: 'local' },
    ])
    expect(turnSkillsOf([{ name: 'context7', enabled: false, url: null }])).toEqual([
      { name: 'playwright', kind: 'local' },
    ])
  })

  it('adds the remote skills that are on, by name, after the platform ones', () => {
    const skills = turnSkillsOf([
      { name: 'zeta', enabled: true, url: 'https://mcp.zeta.example.com/mcp' },
      { name: 'alpha', enabled: true, url: 'https://alpha.example.org:8443/sse' },
      { name: 'off', enabled: false, url: 'https://off.example.org/mcp' },
      { name: 'playwright', enabled: false, url: null },
      // A row the platform would not write is left out, never passed on.
      { name: 'broken', enabled: true, url: 'http://broken.example.org/mcp' },
    ])
    expect(skills).toEqual([
      { name: 'context7', kind: 'remote', url: CONTEXT7_MCP_URL },
      { name: 'alpha', kind: 'remote', url: 'https://alpha.example.org:8443/sse' },
      { name: 'zeta', kind: 'remote', url: 'https://mcp.zeta.example.com/mcp' },
    ])
    expect(turnSkillsSchema.safeParse(skills).success).toBe(true)
  })

  it('takes only an https address of a public name without anything secret', () => {
    expect(parseAgentSkillUrl('https://Mcp.Example.com/mcp')).toBe('https://mcp.example.com/mcp')
    expect(parseAgentSkillUrl('https://mcp.example.com:443/mcp')).toBe(
      'https://mcp.example.com/mcp',
    )
    expect(agentSkillUrlSchema.parse(' https://mcp.example.com/mcp ')).toBe(
      'https://mcp.example.com/mcp',
    )
    for (const bad of [
      'http://mcp.example.com/mcp',
      'https://user:pass@mcp.example.com/mcp',
      'https://mcp.example.com/mcp?key=secret',
      'https://mcp.example.com/mcp#key',
      'https://mcp.example.com:8080/mcp',
      'https://127.0.0.1/mcp',
      'https://[::1]/mcp',
      'https://localhost/mcp',
      'https://vault.internal/mcp',
      'https://mcp.example.com/{env:HOME}',
      'https://mcp.example.com/a b',
      `https://mcp.example.com/${'a'.repeat(600)}`,
      'mcp.example.com/mcp',
    ])
      expect(parseAgentSkillUrl(bad), bad).toBeNull()
  })

  it('names a skill so that its tools never share the prefix of the platform', () => {
    for (const good of ['docs', 'my-docs', 'a1'])
      expect(agentSkillNameSchema.safeParse(good).success, good).toBe(true)
    for (const bad of [
      'raditi',
      'raditi-docs',
      'Docs',
      'my_docs',
      '-docs',
      'docs-',
      'a'.repeat(33),
    ])
      expect(agentSkillNameSchema.safeParse(bad).success, bad).toBe(false)
  })

  it('refuses a turn with one name twice', () => {
    expect(
      turnSkillsSchema.safeParse([
        { name: 'playwright', kind: 'local' },
        { name: 'playwright', kind: 'local' },
      ]).success,
    ).toBe(false)
  })
})
