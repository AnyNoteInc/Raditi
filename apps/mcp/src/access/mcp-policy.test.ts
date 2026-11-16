import { describe, expect, it } from 'vitest'

import { parseMcpHosts } from '../config/allowed-hosts.ts'
import { loadMcpConfig } from '../config/config.ts'
import { testMcpConfig } from '../testing/fakes.ts'
import type { McpTurnAccess } from './mcp-access.ts'
import {
  mcpBodyAllowed,
  mcpCallNeedsClient,
  mcpHeadersAllowed,
  mcpSecurityOf,
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
      'pages_changes',
    ])
    const page = (name: string, args: unknown) => ({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    })
    expect(
      mcpBodyAllowed(page('page_publish', { file: 'p.html', title: 'П' }), ['pages_changes']),
    ).toBe(true)
    expect(mcpBodyAllowed(page('page_list', {}), ['pages'])).toBe(true)
    expect(mcpBodyAllowed(page('page_list', {}), ['search'])).toBe(false)
    expect(mcpBodyAllowed(page('page_list', {}), ['pages_changes'])).toBe(false)
    expect(
      mcpBodyAllowed(page('page_publish', { file: 'p.html', title: 'П', docId: access.taskId }), [
        'pages',
        'pages_changes',
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
    // Merge and deploy are presses of the client only (84.22, ПР15): no call of any shape passes.
    for (const name of ['repo_push', 'repo_merge', 'repo_deploy', 'repo_accept', 'repo_play'])
      for (const args of [{}, { number: 7 }, { number: 7, mode: 'now' }, { jobId: '1' }])
        expect(
          mcpBodyAllowed(page(name, args), ['repo', 'memory', 'web', 'pages', 'docs', 'search']),
        ).toBe(false)
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

describe('the scheduled tasks of the chat’s author (plan 82, Зп31, Зп32)', () => {
  const access: McpTurnAccess = {
    keyId: '01960000-0000-7000-8000-000000000001',
    taskId: '01960000-0000-7000-8000-000000000002',
    workspaceId: '01960000-0000-7000-8000-000000000003',
    sessionId: 'synthetic',
    turn: 1,
    firstEpoch: 1,
    epoch: 1,
    requirements: { repository: false, browser: true },
  }
  const base = { allowedHosts: ['mcp'], allowLocalOrigin: false }
  const call = (name: string, args?: unknown) => ({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name, ...(args === undefined ? {} : { arguments: args }) },
  })
  const create = {
    name: 'Курс валют',
    instructions: 'Пришли курс доллара по ЦБ на сегодня.',
    triggers: [{ kind: 'weekdays', time: '09:00' }],
    confirmedByClient: true,
  }

  it('are offered to every turn, and changed only by a turn the client watches', () => {
    expect(mcpSecurityOf(testMcpConfig()).scheduleTools).toBe(true)
    const security: McpSecurity = { ...base, scheduleTools: true }
    expect(mcpToolFamiliesOf(access, security)).toEqual(['schedule', 'schedule_changes'])
    expect(mcpToolFamiliesOf({ ...access, unattended: false }, security)).toEqual([
      'schedule',
      'schedule_changes',
    ])
    // A pass of a scheduled run without its client: the list alone.
    expect(mcpToolFamiliesOf({ ...access, unattended: true }, security)).toEqual(['schedule'])
    // A chat without the browser has them alike (Зп54).
    const chat = { ...access, requirements: { repository: false, browser: false } }
    expect(mcpToolFamiliesOf(chat, security)).toEqual(['schedule', 'schedule_changes'])
    expect(mcpToolFamiliesOf(access, base)).toEqual([])
  })

  it('leaves a pass without its client the pages to read and nothing to change (Зп28)', () => {
    const security: McpSecurity = { ...base, pagesTools: true, docsTools: true }
    expect(mcpToolFamiliesOf(access, security)).toEqual(['docs', 'pages', 'pages_changes'])
    const unattended = mcpToolFamiliesOf({ ...access, unattended: true }, security)
    // Its documents are the chat's own; a page is live for every visitor once the turn ends.
    expect(unattended).toEqual(['docs', 'pages'])
    for (const body of [
      call('page_publish', { file: 'p.html', title: 'Акции' }),
      call('page_publish', {
        file: 'p.html',
        title: 'Акции',
        pageId: access.taskId,
        expectedVersion: 2,
      }),
      call('page_edit', {
        pageId: access.taskId,
        expectedVersion: 2,
        edits: [{ old: 'Старая цена', new: 'Новая цена' }],
      }),
      call('page_update', { pageId: access.taskId, expectedVersion: 2, title: 'Акции' }),
      call('page_file_put', { treeId: access.taskId, file: 'app.js', path: '/_files/app.js' }),
      call('page_restore', { pageIds: [access.taskId] }),
    ]) {
      // A well-formed change: the client's turn calls it; a pass without the client cannot.
      expect(mcpBodyAllowed(body, ['pages', 'pages_changes']), JSON.stringify(body)).toBe(true)
      expect(mcpBodyAllowed(body, unattended), JSON.stringify(body)).toBe(false)
    }
    expect(mcpBodyAllowed(call('page_list', {}), unattended)).toBe(true)
    expect(mcpBodyAllowed(call('page_read', { pageId: access.taskId }), unattended)).toBe(true)
  })

  it('admits the list to the family schedule and the changes to schedule_changes alone', () => {
    expect(mcpBodyAllowed(call('schedule_list'), ['schedule'])).toBe(true)
    expect(mcpBodyAllowed(call('schedule_list', {}), ['schedule'])).toBe(true)
    expect(mcpBodyAllowed(call('schedule_list', { userId: access.taskId }), ['schedule'])).toBe(
      false,
    )
    expect(mcpBodyAllowed(call('schedule_list', {}), ['pages'])).toBe(false)
    const changes = [
      call('schedule_create', create),
      call('schedule_create', {
        ...create,
        effort: 'low',
        timezone: 'Asia/Novosibirsk',
        notify: false,
        triggers: [{ kind: 'once', inMinutes: 30 }],
      }),
      call('schedule_update', {
        scheduleId: access.taskId,
        enabled: false,
        confirmedByClient: true,
      }),
      call('schedule_update', {
        reservedId: access.taskId,
        triggers: [{ kind: 'weekly', time: '16:00', days: [1, 5] }],
        confirmedByClient: true,
      }),
      call('schedule_delete', { scheduleId: access.taskId, confirmedByClient: true }),
      call('schedule_delete', { reservedId: access.taskId, confirmedByClient: true }),
    ]
    for (const body of changes) {
      expect(mcpBodyAllowed(body, ['schedule_changes']), JSON.stringify(body)).toBe(true)
      // The list's family never calls a change: a pass without the client has only that.
      expect(mcpBodyAllowed(body, ['schedule', 'pages', 'web'])).toBe(false)
    }
    // The place of a template left for the client's words is the store's refusal, a result of
    // the tool (Зп59), not a request refused as a whole.
    expect(
      mcpBodyAllowed(
        call('schedule_create', {
          ...create,
          instructions: 'Открой сайт [впишите адрес сайта] и проверь главную.',
        }),
        ['schedule_changes'],
      ),
    ).toBe(true)
    // Runs closer than an hour are the tool's own refusal, not a request refused as a whole.
    expect(
      mcpBodyAllowed(
        call('schedule_create', {
          ...create,
          triggers: [
            { kind: 'daily', time: '09:00' },
            { kind: 'daily', time: '09:30' },
          ],
        }),
        ['schedule_changes'],
      ),
    ).toBe(true)
    const refused = [
      // Who and where are never arguments (Зп54).
      call('schedule_create', { ...create, workspaceId: access.workspaceId }),
      call('schedule_create', { ...create, chatId: access.taskId }),
      call('schedule_create', { ...create, confirmedByClient: false }),
      call('schedule_create', { ...create, confirmedByClient: undefined }),
      call('schedule_create', { ...create, name: ' Проверка' }),
      call('schedule_create', { ...create, triggers: [{ kind: 'daily', time: '9:00' }] }),
      call('schedule_create', { ...create, triggers: [{ kind: 'cron', expression: '* * * * *' }] }),
      call('schedule_create', { ...create, triggers: [{ kind: 'once', inMinutes: 1 }] }),
      call('schedule_create', { ...create, timezone: 'Mars/Olympus' }),
      call('schedule_create'),
      call('schedule_update', { scheduleId: access.taskId, confirmedByClient: true }),
      call('schedule_update', {
        scheduleId: access.taskId,
        reservedId: access.taskId,
        enabled: true,
        confirmedByClient: true,
      }),
      call('schedule_delete', { confirmedByClient: true }),
      call('schedule_delete', { scheduleId: access.taskId }),
    ]
    for (const body of refused)
      expect(mcpBodyAllowed(body, ['schedule', 'schedule_changes']), JSON.stringify(body)).toBe(
        false,
      )
  })

  it('names a well-formed call that needs the client’s word, of any tool', () => {
    expect(mcpCallNeedsClient(call('schedule_create', create))).toBe(true)
    expect(
      mcpCallNeedsClient(
        call('page_delete', { pageIds: [access.taskId], confirmedByClient: true }),
      ),
    ).toBe(true)
    // However it says it: the key is the question, not its value.
    expect(mcpCallNeedsClient(call('some_tool', { confirmedByClient: false }))).toBe(true)
    // A change of the tasks or of the pages a pass without its client is not offered, by its
    // name, whatever its arguments: what it publishes is live for every visitor (Зп28).
    for (const name of [
      'schedule_create',
      'schedule_update',
      'schedule_delete',
      'page_publish',
      'page_edit',
      'page_update',
      'page_delete',
      'page_restore',
      'page_file_put',
      'page_file_delete',
    ]) {
      expect(mcpCallNeedsClient(call(name, {})), name).toBe(true)
      expect(mcpCallNeedsClient(call(name)), name).toBe(true)
    }
    for (const body of [
      call('schedule_list', {}),
      call('schedule_list'),
      call('page_list', {}),
      call('page_read', { pageId: access.taskId }),
      call('page_tree', { treeId: access.taskId }),
      call('page_files', { treeId: access.taskId }),
      call('doc_create', { title: 'Отчёт' }),
      call('web_click', { observation: 'o1', ref: 'e5' }),
      { ...call('page_publish', {}), id: undefined },
      { ...call('page_delete', { confirmedByClient: true }), id: undefined },
      { ...call('page_delete', { confirmedByClient: true }), method: 'tools/list' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { ...call('page_delete', JSON.parse('{"__proto__":{},"confirmedByClient":true}')) },
      null,
      'tools/call',
    ])
      expect(mcpCallNeedsClient(body), JSON.stringify(body)).toBe(false)
  })
})
