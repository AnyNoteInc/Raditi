import { describe, expect, it } from 'vitest'

import { parseMcpHosts } from '../config/allowed-hosts.ts'
import { loadMcpConfig } from '../config/config.ts'
import { testMcpConfig } from '../testing/fakes.ts'
import type { McpAccess } from './mcp-access.ts'
import {
  mcpBodyAllowed,
  mcpHeadersAllowed,
  mcpToolFamiliesOf,
  type McpSecurity,
} from './mcp-policy.ts'

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

  it('requires the exact upstream Host names in production', () => {
    const config = testMcpConfig()
    const env = {
      APP_ENV: 'production',
      DATABASE_URL: config.db.databaseUrl,
      VAULT_ADDR: 'https://vault.example.test',
      VAULT_ROLE_ID: 'role',
      VAULT_SECRET_ID: 'secret',
    }
    expect(() => loadMcpConfig(env)).toThrow(/MCP_ALLOWED_HOSTS/)
    expect(loadMcpConfig({ ...env, MCP_ALLOWED_HOSTS: 'mcp' }).allowedHosts).toEqual(['mcp'])
  })

  it('offers content into a preview with its database, the browser on an open preview, never more', () => {
    const access = (preview: McpAccess['preview']): McpAccess => ({
      keyId: '01960000-0000-7000-8000-000000000001',
      taskId: '01960000-0000-7000-8000-000000000002',
      workspaceId: '01960000-0000-7000-8000-000000000003',
      siteId: '01960000-0000-7000-8000-000000000004',
      sessionId: 'synthetic',
      turn: 1,
      firstEpoch: 1,
      epoch: 1,
      stack: 'wordpress',
      url: 'https://site.example.test',
      preview,
    })
    const preview = (status: NonNullable<McpAccess['preview']>['status'], database = true) => ({
      id: '01960000-0000-7000-8000-000000000005',
      status,
      database,
      hostname: 'site-0a1b2c3d-chat-0a1b2c.localhost',
    })
    const base = { allowedHosts: ['mcp'], allowLocalOrigin: false }
    const both: McpSecurity = { ...base, contentTools: true, browserTools: true }
    // Р3, Р4: the preview with its own database takes content; one without, or gone, takes none.
    // `db_schema` where the build found tables writable — or before any build has said: the
    // CLI asks for its tools once, as its first turn starts beside the build (each call checks).
    const built = (kinds: NonNullable<McpAccess['preview']>['dbKinds']) => ({
      ...preview('ready'),
      dbKinds: kinds,
    })
    expect(mcpToolFamiliesOf(access(built(['content_update'])), both)).toEqual([
      'content',
      'browser',
    ])
    expect(mcpToolFamiliesOf(access(built(['content_update', 'schema_migration'])), both)).toEqual([
      'content',
      'schema',
      'browser',
    ])
    expect(mcpToolFamiliesOf(access(preview('ready')), both)).toEqual([
      'content',
      'schema',
      'browser',
    ])
    expect(mcpToolFamiliesOf(access(preview('building')), both)).toEqual([
      'content',
      'schema',
      'browser',
    ])
    expect(mcpToolFamiliesOf(access(preview('ready', false)), both)).toEqual(['browser'])
    for (const closed of ['unavailable', 'destroyed'] as const)
      expect(mcpToolFamiliesOf(access(preview(closed)), both)).toEqual([])
    // Without a preview: no browser, and the site itself only on the P6 path of the stands.
    expect(mcpToolFamiliesOf(access(null), both)).toEqual([])
    expect(mcpToolFamiliesOf(access(null), { ...both, siteContent: true })).toEqual(['content'])
    // A preview never opens the site's path, whatever the role allows.
    expect(
      mcpToolFamiliesOf(access(preview('ready', false)), { ...both, siteContent: true }),
    ).toEqual(['browser'])
    // Families follow the profiles of the role.
    expect(mcpToolFamiliesOf(access(preview('ready')), base)).toEqual([])
    expect(mcpToolFamiliesOf(access(preview('ready')), { ...base, browserTools: true })).toEqual([
      'browser',
    ])
  })

  it('admits a call of a family only to a request of that family, by its strict arguments', () => {
    const call = (name: string, args?: unknown) => ({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, ...(args === undefined ? {} : { arguments: args }) },
    })
    const allowed = [
      call('browser_navigate', { path: '/about/' }),
      call('browser_click', { selector: '#go' }),
      call('browser_click', { role: 'button', name: 'Отправить' }),
      call('browser_fill', { selector: '#name', value: 'Анна' }),
      call('browser_expect', { selector: 'h1', text: 'О нас' }),
      call('browser_expect', { selector: 'h1', state: 'hidden' }),
      call('browser_snapshot', {}),
      call('browser_snapshot'),
      call('browser_screenshot', {}),
      call('browser_console', {}),
      call('browser_network', {}),
      call('browser_run_checks', { checks: [{ path: '/', status: 200, selector: 'h1' }] }),
    ]
    for (const body of allowed) {
      expect(mcpBodyAllowed(body, ['browser'])).toBe(true)
      // A request without a preview names no browser tool.
      expect(mcpBodyAllowed(body, ['content'])).toBe(false)
      expect(mcpBodyAllowed(body)).toBe(false)
    }
    const refused = [
      // The preview, the site or an origin are never arguments.
      call('browser_navigate', { path: '/', previewId: 'foreign' }),
      call('browser_navigate', {}),
      call('browser_navigate', { path: '/\nx' }),
      call('browser_click', { selector: '#go', role: 'button' }),
      call('browser_click', { name: 'Отправить' }),
      call('browser_click', { role: 'Button' }),
      call('browser_fill', { selector: '#name' }),
      call('browser_fill', { selector: '#name', value: 'x'.repeat(10_001) }),
      call('browser_expect', { selector: 'h1', state: 'visible', text: 'x' }),
      call('browser_expect', { selector: 'h1', state: 'shown' }),
      call('browser_snapshot', { full: true }),
      call('browser_run_checks', { checks: [] }),
      call('browser_run_checks', { checks: Array.from({ length: 11 }, () => ({ path: '/' })) }),
      call('browser_run_checks', { checks: [{ path: '/', text: 'без элемента' }] }),
      // Agent-written code has no tool.
      call('browser_run_checks', { checks: [{ path: '/', script: 'alert(1)' }] }),
      call('browser_evaluate', { expression: 'document.cookie' }),
    ]
    for (const body of refused) expect(mcpBodyAllowed(body, ['browser', 'content'])).toBe(false)
    expect(
      mcpBodyAllowed(call('wp_rest', { method: 'GET', route: '/wp/v2/pages/42' }), ['browser']),
    ).toBe(false)
    expect(
      mcpBodyAllowed(call('wp_rest', { method: 'GET', route: '/wp/v2/pages/42' }), ['content']),
    ).toBe(true)
  })

  it('offers web tools to a task that needs a browser where the worker is configured', () => {
    const access = (
      requirements: McpAccess['requirements'],
      preview: McpAccess['preview'] = null,
    ): McpAccess => ({
      keyId: '01960000-0000-7000-8000-000000000001',
      taskId: '01960000-0000-7000-8000-000000000002',
      workspaceId: '01960000-0000-7000-8000-000000000003',
      siteId: '01960000-0000-7000-8000-000000000004',
      sessionId: 'synthetic',
      turn: 1,
      firstEpoch: 1,
      epoch: 1,
      stack: 'wordpress',
      url: 'https://site.example.test',
      preview,
      ...(requirements === undefined ? {} : { requirements }),
    })
    const browserOnly = { repository: false, browser: true }
    const repositoryOnly = { repository: true, browser: false }
    const base = { allowedHosts: ['mcp'], allowLocalOrigin: false }
    const all: McpSecurity = {
      ...base,
      contentTools: true,
      siteContent: true,
      browserTools: true,
      webTools: true,
    }
    // Б20: the cloud browser of the task, on the site itself.
    expect(mcpToolFamiliesOf(access(browserOnly), all)).toEqual(['web'])
    expect(mcpToolFamiliesOf(access(browserOnly), { ...all, webTools: false })).toEqual([])
    // Б1: a task without a repository never writes content, even on the P6 path of the stands.
    expect(mcpToolFamiliesOf(access(repositoryOnly), all)).toEqual(['content'])
    // A scope made before requirements is a repository task: no web tools.
    expect(mcpToolFamiliesOf(access(undefined), all)).toEqual(['content'])
    // Both needs, as schemas allow: each family by its own rule.
    expect(
      mcpToolFamiliesOf(
        access(
          { repository: true, browser: true },
          {
            id: '01960000-0000-7000-8000-000000000005',
            status: 'ready',
            database: true,
            hostname: 'site-0a1b2c3d-chat-0a1b2c.localhost',
            dbKinds: ['content_update'],
          },
        ),
        all,
      ),
    ).toEqual(['content', 'browser', 'web'])
  })

  it('admits web calls only to the web family, by the arguments of the domain', () => {
    const call = (name: string, args?: unknown) => ({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, ...(args === undefined ? {} : { arguments: args }) },
    })
    const id = '01960000-0000-7000-8000-00000000000a'
    const allowed = [
      call('web_open', { url: '/wp-admin/post-new.php' }),
      call('web_observe'),
      call('web_observe', { maxChars: 8000, ref: 'f1e5' }),
      call('web_click', { observation: 'o3', ref: 'e12' }),
      call('web_click', { observation: 'o3', ref: 'e12', button: 'right', double: true }),
      call('web_fill', { observation: 'o3', ref: 'e12', text: 'Новость дня' }),
      call('web_type', { text: 'Первый абзац.' }),
      call('web_press', { key: 'Control+A' }),
      call('web_press', { key: 'Enter', observation: 'o3', ref: 'e2' }),
      call('web_scroll', { direction: 'down' }),
      call('web_tab', { action: 'list' }),
      call('web_tab', { action: 'select', pageId: 2 }),
      call('web_upload', { attachmentIds: [id] }),
      call('web_upload', { observation: 'o3', ref: 'e7', attachmentIds: [id] }),
      call('web_dialog', { accept: true }),
      call('web_wait', { ms: 2000, until: 'load' }),
      call('web_help', { reason: 'login', message: 'Пожалуйста, войдите в админку сайта.' }),
      call('web_verify'),
      call('web_verify', { expect: 'publish' }),
      // A snapshot for the client: the model gets its number, never its pixels (Б20).
      call('web_screenshot'),
    ]
    for (const body of allowed) {
      expect(mcpBodyAllowed(body, ['web'])).toBe(true)
      // The preview's browser and content families name no web tool.
      expect(mcpBodyAllowed(body, ['browser', 'content', 'schema'])).toBe(false)
      expect(mcpBodyAllowed(body)).toBe(false)
    }
    const refused = [
      // A session, a task or a site are never arguments.
      call('web_open', { url: '/', sessionId: id }),
      call('web_open', {}),
      call('web_open', { url: 'x'.repeat(2049) }),
      call('web_click', { ref: 'e12' }),
      call('web_click', { observation: 'o3', ref: 'button' }),
      call('web_fill', { observation: 'o3', ref: 'e1', text: 'a\u0000b' }),
      call('web_type', { text: '' }),
      call('web_press', { key: 'Control+Control+A' }),
      call('web_press', { key: 'Enter', ref: 'e2' }),
      call('web_scroll', { direction: 'down', amount: 10_001 }),
      call('web_tab', { action: 'list', pageId: 1 }),
      call('web_tab', { action: 'close' }),
      call('web_upload', { attachmentIds: [] }),
      call('web_upload', { attachmentIds: [id, id] }),
      call('web_upload', { attachmentIds: ['inbox/key'] }),
      call('web_wait', { ms: 15_001 }),
      call('web_help', { reason: 'password', message: 'x' }),
      call('web_verify', { expect: 'trash' }),
      // No scripts or cookies for the model, and no area of the page to choose for a snapshot.
      call('web_evaluate', { expression: 'document.cookie' }),
      call('web_screenshot', { fullPage: true }),
      call('web_screenshot', { ref: 'e1' }),
    ]
    for (const body of refused) expect(mcpBodyAllowed(body, ['web', 'browser'])).toBe(false)
  })
})
