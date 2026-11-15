import { describe, expect, it } from 'vitest'

import {
  agentSkillHeaderNameSchema,
  agentSkillHeaderValueSchema,
  agentSkillNameSchema,
  agentSkillUrlSchema,
  CONTEXT7_MCP_URL,
  parseAgentSkillUrl,
  SKILL_RELAY_PATH,
  skillRelayPath,
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

  it('gives a turn with the platform browser no local browser of its own', () => {
    expect(turnSkillsOf([], { platformBrowser: true })).toEqual([
      { name: 'context7', kind: 'remote', url: CONTEXT7_MCP_URL },
    ])
    const added = { name: 'alpha', enabled: true, url: 'https://alpha.example.org/mcp' }
    expect(turnSkillsOf([added], { platformBrowser: true }).map((skill) => skill.name)).toEqual([
      'context7',
      'alpha',
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

  it('sends a server with authorization through the relay and leaves out one to sign in again', () => {
    const url = 'https://mcp.example.com/mcp'
    const skills = turnSkillsOf(
      [
        { name: 'keyed', enabled: true, url, authKind: 'header', authState: 'ok' },
        { name: 'login', enabled: true, url, authKind: 'oauth', authState: 'needs_login' },
        { name: 'broken', enabled: true, url, authKind: 'header', authState: 'failed' },
        { name: 'open', enabled: true, url, authKind: 'none' },
      ],
      { platformBrowser: true },
    )
    expect(skills).toEqual([
      { name: 'context7', kind: 'remote', url: CONTEXT7_MCP_URL },
      { name: 'keyed', kind: 'relayed' },
      { name: 'open', kind: 'remote', url },
    ])
    expect(turnSkillsSchema.safeParse(skills).success).toBe(true)
    // A relayed skill carries no address: the plan of a turn never holds where the key goes.
    expect(turnSkillsSchema.safeParse([{ name: 'keyed', kind: 'relayed', url }]).success).toBe(
      false,
    )
  })

  it('serves exactly one relay path per name', () => {
    expect(skillRelayPath('my-docs')).toBe('/mcp/skill/my-docs')
    expect(SKILL_RELAY_PATH.exec('/mcp/skill/my-docs')?.[1]).toBe('my-docs')
    for (const bad of [
      '/mcp/skill/',
      '/mcp/skill/a/b',
      '/mcp/skill/My',
      '/mcp/skill/a?x=1',
      '/mcp',
    ])
      expect(SKILL_RELAY_PATH.test(bad), bad).toBe(false)
  })

  it('takes a header of the owner and never one the relay owns', () => {
    for (const good of ['Authorization', 'X-Api-Key', 'api_key'])
      expect(agentSkillHeaderNameSchema.safeParse(good).success, good).toBe(true)
    for (const bad of [
      'Host',
      'cookie',
      'Mcp-Session-Id',
      'X-Forwarded-For',
      'Bad Name',
      'a:b',
      '',
    ])
      expect(agentSkillHeaderNameSchema.safeParse(bad).success, bad).toBe(false)
    expect(agentSkillHeaderValueSchema.safeParse('Bearer sk_live_123').success).toBe(true)
    for (const bad of ['short', 'line\r\nInjected: 1', ' padded-value ', 'ключ-ключ-ключ'])
      expect(agentSkillHeaderValueSchema.safeParse(bad).success, bad).toBe(false)
  })
})
