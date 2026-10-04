import { describe, expect, it } from 'vitest'

import { loadConfig } from '../config/config.ts'
import { testMcpConfig } from '../testing/fakes.ts'
import { mcpBodyAllowed, mcpHeadersAllowed, parseMcpHosts } from './mcp-policy.ts'

describe('MCP request policy', () => {
  it('accepts only exact upstream hosts and requires them in production', () => {
    expect(parseMcpHosts('mcp,10.0.0.2,[fd00::2],MCP', true)).toEqual([
      'mcp',
      '10.0.0.2',
      '[fd00::2]',
    ])
    expect(() => parseMcpHosts(undefined, true)).toThrow(/MCP_ALLOWED_HOSTS/)
    // Outside production the default matches LLM_GATEWAY_HOSTS: a Docker Desktop sandbox-gw
    // rewrites Host to host.docker.internal for both upstreams.
    expect(parseMcpHosts(undefined, false)).toEqual([
      'localhost',
      '127.0.0.1',
      '[::1]',
      'host.docker.internal',
    ])
    expect(
      mcpHeadersAllowed(
        { host: 'host.docker.internal:8082' },
        { allowedHosts: parseMcpHosts('', false), allowLocalOrigin: false },
      ),
    ).toBe(true)
    for (const value of ['*', '*.example.test', 'mcp:8082', 'https://mcp', '', 'mcp,', '::1'])
      expect(() => parseMcpHosts(value, true)).toThrow(/MCP_ALLOWED_HOSTS/)
    const security = { allowedHosts: ['mcp', '10.0.0.2'], allowLocalOrigin: false }
    expect(mcpHeadersAllowed({ host: 'mcp:8082' }, security)).toBe(true)
    expect(mcpHeadersAllowed({ host: '10.0.0.2:8082' }, security)).toBe(true)
    for (const host of [
      'evil.example',
      'mcp.evil.example',
      'mcp@evil.example',
      'mcp/extra',
      'mcp?x=1',
    ])
      expect(mcpHeadersAllowed({ host }, security)).toBe(false)
    expect(mcpHeadersAllowed({ host: 'mcp', origin: 'http://mcp' }, security)).toBe(false)
  })

  it('bounds parsed structures and refuses prototype keys and notification request ids', () => {
    const call = {
      jsonrpc: '2.0',
      id: 0,
      method: 'tools/call',
      params: { name: 'site_info', arguments: {} },
    }
    expect(mcpBodyAllowed(call)).toBe(true)
    expect(mcpBodyAllowed({ ...call, params: { name: 'site_info' } })).toBe(true)
    expect(
      mcpBodyAllowed({ ...call, params: { ...call.params, _meta: { progressToken: 0 } } }),
    ).toBe(true)
    expect(
      mcpBodyAllowed({ ...call, params: { name: 'site_info', arguments: { siteId: 'foreign' } } }),
    ).toBe(false)
    for (const key of ['__proto__', 'constructor', 'prototype'])
      expect(mcpBodyAllowed({ ...call, params: JSON.parse(`{"${key}":{}}`) })).toBe(false)
    expect(
      mcpBodyAllowed({ ...call, params: { name: 'site_info', many: Array(5000).fill(1) } }),
    ).toBe(false)
    expect(mcpBodyAllowed({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(true)
    expect(mcpBodyAllowed({ jsonrpc: '2.0', id: 1, method: 'notifications/initialized' })).toBe(
      false,
    )
  })

  it('canonicalises equivalent IPv6 configuration and Host headers', () => {
    const allowedHosts = parseMcpHosts('[0:0:0:0:0:0:0:1],[::1],[fd00:0:0:0:0:0:0:2]', true)
    expect(allowedHosts).toEqual(['[::1]', '[fd00::2]'])
    const security = { allowedHosts, allowLocalOrigin: false }
    for (const host of [
      '[::1]:8082',
      '[0:0:0:0:0:0:0:1]',
      '[fd00::2]',
      '[fd00:0:0:0:0:0:0:2]:8082',
    ])
      expect(mcpHeadersAllowed({ host }, security)).toBe(true)
    expect(mcpHeadersAllowed({ host: '[fd00::3]' }, security)).toBe(false)
  })

  it('validates every allowed method before the SDK can reflect an invalid field', () => {
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }
    expect(mcpBodyAllowed(initialize)).toBe(true)
    expect(
      mcpBodyAllowed({
        ...initialize,
        params: { ...initialize.params, capabilities: { experimental: { private: 'invalid' } } },
      }),
    ).toBe(false)
    expect(
      mcpBodyAllowed({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { cursor: {} } }),
    ).toBe(false)
    expect(
      mcpBodyAllowed({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: {} },
      }),
    ).toBe(false)
    expect(
      mcpBodyAllowed({
        jsonrpc: '2.0',
        id: 1,
        method: 'logging/setLevel',
        params: { level: 'error' },
      }),
    ).toBe(false)
  })

  it('validates MCP settings only for the selected role', () => {
    const config = testMcpConfig()
    const env = {
      APP_ENV: 'production',
      ORCHESTRATOR_ROLES: 'mcp',
      DATABASE_URL: config.db.databaseUrl,
      VAULT_ADDR: 'https://vault.example.test',
      VAULT_ROLE_ID: 'role',
      VAULT_SECRET_ID: 'secret',
    }
    expect(() => loadConfig(env)).toThrow(/MCP_ALLOWED_HOSTS/)
    expect(loadConfig({ ...env, MCP_ALLOWED_HOSTS: 'mcp' }).mcp?.allowedHosts).toEqual(['mcp'])
    expect(
      loadConfig({
        APP_ENV: 'test',
        ORCHESTRATOR_ROLES: 'runner',
        RUNNER_CORE_URL: 'http://127.0.0.1:8083',
        RUNNER_TOKEN_FILE: '/run/token',
        MCP_ALLOWED_HOSTS: 'invalid/unused',
      }).mcp,
    ).toBeNull()
  })
})
