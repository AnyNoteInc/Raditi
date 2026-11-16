import { describe, expect, it } from 'vitest'

import { parseMcpHosts } from '../config/allowed-hosts.ts'
import { loadMcpConfig } from '../config/config.ts'
import { testMcpConfig } from '../testing/fakes.ts'
import type { McpTurnAccess } from './mcp-access.ts'
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
      SANDBOX_EGRESS_REFUSED_SUBNETS: '45.8.250.117/32',
    }
    expect(() => loadMcpConfig(env)).toThrow(/MCP_ALLOWED_HOSTS/)
    expect(loadMcpConfig({ ...env, MCP_ALLOWED_HOSTS: 'mcp' }).allowedHosts).toEqual(['mcp'])
  })

  it('offers web tools to a chat that needs a browser where the worker is configured', () => {
    const access = (requirements: McpTurnAccess['requirements']): McpTurnAccess => ({
      keyId: '01960000-0000-7000-8000-000000000001',
      taskId: '01960000-0000-7000-8000-000000000002',
      workspaceId: '01960000-0000-7000-8000-000000000003',
      sessionId: 'synthetic',
      turn: 1,
      firstEpoch: 1,
      epoch: 1,
      requirements,
    })
    const base = { allowedHosts: ['mcp'], allowLocalOrigin: false }
    const all: McpSecurity = { ...base, webTools: true }
    // Б20: the cloud browser of the chat.
    expect(mcpToolFamiliesOf(access({ repository: false, browser: true }), all)).toEqual(['web'])
    expect(mcpToolFamiliesOf(access({ repository: false, browser: true }), base)).toEqual([])
    expect(mcpToolFamiliesOf(access({ repository: false, browser: false }), all)).toEqual([])
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
      expect(mcpBodyAllowed(body, ['search', 'docs', 'pages'])).toBe(false)
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
    for (const body of refused) expect(mcpBodyAllowed(body, ['web'])).toBe(false)
  })

  it('offers search_web to every turn, only where its key is configured', () => {
    const access: McpTurnAccess = {
      keyId: '01960000-0000-7000-8000-000000000001',
      taskId: '01960000-0000-7000-8000-000000000002',
      workspaceId: '01960000-0000-7000-8000-000000000003',
      sessionId: 'synthetic',
      turn: 1,
      firstEpoch: 1,
      epoch: 1,
      requirements: { repository: false, browser: false },
    }
    const base = { allowedHosts: ['mcp'], allowLocalOrigin: false }
    const chat = access
    expect(mcpToolFamiliesOf(access, base)).toEqual([])
    expect(mcpToolFamiliesOf(chat, { ...base, searchTools: true })).toEqual(['search'])
    expect(
      mcpToolFamiliesOf(
        { ...chat, requirements: { repository: false, browser: true } },
        { ...base, webTools: true, searchTools: true },
      ),
    ).toEqual(['web', 'search'])

    const call = (args: unknown) => ({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search_web', arguments: args },
    })
    expect(mcpBodyAllowed(call({ query: 'wordpress register_post_type' }), ['search'])).toBe(true)
    // Not without the family, whatever else the request may call.
    expect(mcpBodyAllowed(call({ query: 'wordpress register_post_type' }), ['web', 'docs'])).toBe(
      false,
    )
    for (const args of [
      {},
      { query: 'x' },
      { query: 'a'.repeat(201) },
      { query: 'two\nlines' },
      { query: 'ok words', mode: 'advanced' },
      { query: ['wordpress'] },
    ])
      expect(mcpBodyAllowed(call(args), ['search'])).toBe(false)

    // The pages of the workspace (docs/plan/69-pages.md, Ст20): any turn, where they are configured.
    expect(mcpToolFamiliesOf(chat, { ...base, searchTools: true, pagesTools: true })).toEqual([
      'search',
      'pages',
    ])
    const page = (name: string, args: unknown) => ({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    })
    expect(mcpBodyAllowed(page('page_publish', { file: 'p.html', title: 'П' }), ['pages'])).toBe(
      true,
    )
    expect(mcpBodyAllowed(page('page_list', {}), ['pages'])).toBe(true)
    expect(mcpBodyAllowed(page('page_list', {}), ['search'])).toBe(false)
    expect(
      mcpBodyAllowed(page('page_publish', { file: 'p.html', title: 'П', docId: access.taskId }), [
        'pages',
      ]),
    ).toBe(false)

    // The documents (Ст21): every turn; each call by its own strict schema.
    expect(mcpToolFamiliesOf(chat, { ...base, docsTools: true })).toEqual(['docs'])
    const docId = access.taskId
    expect(mcpBodyAllowed(page('doc_read', { docId }), ['docs'])).toBe(true)
    expect(mcpBodyAllowed(page('doc_read', { docId }), ['pages'])).toBe(false)
    expect(mcpBodyAllowed(page('doc_read', { docId, extra: 1 }), ['docs'])).toBe(false)
    expect(
      mcpBodyAllowed(page('doc_section_move', { docId, id: 'a', after: null }), ['docs']),
    ).toBe(true)
    expect(mcpBodyAllowed(page('doc_section_move', { docId, id: 'a' }), ['docs'])).toBe(false)
    expect(mcpBodyAllowed(page('doc_delete', { docId }), ['docs'])).toBe(false)

    // The memory of the chat (plan 84, ПР18): only while it is on; each call by its own schema.
    const remembering = { ...chat, memory: { userId: access.taskId, projectId: null } }
    expect(mcpToolFamiliesOf(chat, { ...base, memoryTools: true })).toEqual([])
    expect(mcpToolFamiliesOf(remembering, { ...base, memoryTools: true })).toEqual(['memory'])
    const id = access.taskId
    expect(mcpBodyAllowed(page('memory_save', { kind: 'fact', text: 'а' }), ['memory'])).toBe(true)
    expect(mcpBodyAllowed(page('memory_save', { kind: 'fact', text: 'а' }), ['docs'])).toBe(false)
    expect(mcpBodyAllowed(page('memory_list', {}), ['memory'])).toBe(true)
    expect(
      mcpBodyAllowed(page('memory_update', { id, text: 'б', expectedVersion: 1 }), ['memory']),
    ).toBe(true)
    expect(
      mcpBodyAllowed(page('memory_save', { kind: 'fact', text: 'а', projectId: id }), ['memory']),
    ).toBe(false)
    expect(mcpBodyAllowed(page('memory_forget', { id, expectedVersion: 0 }), ['memory'])).toBe(
      false,
    )

    // The repository (plan 84, 84.19): only a turn whose plan names one; no push, merge or branch.
    const repo = {
      ...chat,
      requirements: { repository: true, browser: false },
      repository: {
        projectId: id,
        projectRepositoryId: id,
        mode: 'write' as const,
        branch: 'raditi/x-00000000',
        baseSha: 'a'.repeat(40),
      },
    }
    expect(mcpToolFamiliesOf(chat, { ...base, repoTools: true })).toEqual([])
    expect(mcpToolFamiliesOf(repo, { ...base, repoTools: true })).toEqual(['repo'])
    expect(mcpBodyAllowed(page('repo_status', {}), ['repo'])).toBe(true)
    expect(mcpBodyAllowed(page('repo_status', {}), ['memory'])).toBe(false)
    expect(
      mcpBodyAllowed(page('repo_request_merge', { title: 'а', description: '' }), ['repo']),
    ).toBe(true)
    expect(
      mcpBodyAllowed(page('repo_request_merge', { title: 'а', description: '', target: 'main' }), [
        'repo',
      ]),
    ).toBe(false)
    for (const name of ['repo_push', 'repo_merge', 'repo_deploy'])
      expect(mcpBodyAllowed(page(name, {}), ['repo'])).toBe(false)
    // The builds (84.21): reads only, strict arguments; no rerun, no cancel.
    expect(mcpBodyAllowed(page('repo_runs', { branch: 'chat', limit: 3 }), ['repo'])).toBe(true)
    expect(mcpBodyAllowed(page('repo_runs', { branch: 'feature' }), ['repo'])).toBe(false)
    expect(mcpBodyAllowed(page('repo_job_log', { runId: '1', jobId: '2' }), ['repo'])).toBe(true)
    expect(
      mcpBodyAllowed(page('repo_job_log', { runId: '1', jobId: '2', tailBytes: 10 ** 6 }), [
        'repo',
      ]),
    ).toBe(false)
    for (const name of ['repo_rerun', 'repo_cancel', 'repo_run_start'])
      expect(mcpBodyAllowed(page(name, {}), ['repo'])).toBe(false)
  })
})
