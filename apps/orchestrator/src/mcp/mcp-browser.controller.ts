import { Inject } from '@nestjs/common'
import { Ctx, Payload } from '@nestjs/microservices'
import { McpController, Tool, ToolScopes, type McpContext } from '@rekog/mcp-nest'
import { isDomainError } from '@repo/domain'

import { MCP_REQUEST_ACCESS } from './mcp-access.ts'
import type { McpRequest } from './mcp-auth.guard.ts'
import {
  browserAgentCodes,
  MCP_BROWSER,
  type BrowserToolResponse,
  type McpBrowserService,
} from './mcp-browser.ts'
import {
  browserClickArgumentsSchema,
  browserExpectArgumentsSchema,
  browserFillArgumentsSchema,
  browserNavigateArgumentsSchema,
  browserNoArgumentsSchema,
  browserRunChecksArgumentsSchema,
  type BrowserClickArguments,
  type BrowserExpectArguments,
  type BrowserFillArguments,
  type BrowserNavigateArguments,
  type BrowserRunChecksArguments,
} from './mcp-browser-tools.ts'
import { mcpCanonicalJson } from './mcp-journal.ts'

/** Fixed, content-free refusals that tell the agent whether a retry can help. */
const agentCodes = new Set<string>(browserAgentCodes)
const reads = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const
const writes = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const

/**
 * The agent's browser on the preview of its dialog (docs/plan/53-chat-preview-release.md, Р21):
 * the browser profile of the role (MCP_BROWSER_PROFILE), declared to a request whose dialog has
 * a preview (`@ToolScopes(['browser'])`, mcpToolFamiliesOf). Tools never name a site, a preview
 * or an origin: the scope of the turn does. Pixels never reach the model (N22).
 */
@McpController()
export class McpBrowserController {
  constructor(@Inject(MCP_BROWSER) private readonly browser: McpBrowserService) {}

  @ToolScopes(['browser'])
  @Tool({
    name: 'browser_navigate',
    description:
      "Open a page of this dialog's preview in the platform's browser. The preview shows the working copy of this turn: files are brought onto it before every action. Give a path such as /about/; admin pages are refused.",
    parameters: browserNavigateArgumentsSchema,
    annotations: { ...reads, destructiveHint: false },
  })
  navigate(@Payload() args: BrowserNavigateArguments, @Ctx() context: McpContext) {
    return this.#call(context, (scope) => this.browser.navigate(scope, args))
  }

  @ToolScopes(['browser'])
  @Tool({
    name: 'browser_click',
    description:
      'Click an element of the open page: by a Playwright selector, or by an ARIA role and its accessible name. A click may change the preview; its data is rebuilt before the client reviews it.',
    parameters: browserClickArgumentsSchema,
    annotations: writes,
  })
  click(@Payload() args: BrowserClickArguments, @Ctx() context: McpContext) {
    return this.#call(context, (scope) => this.browser.click(scope, args))
  }

  @ToolScopes(['browser'])
  @Tool({
    name: 'browser_fill',
    description:
      'Type a value into a field of the open page. Contact markers of this task are typed as the contacts they hide.',
    parameters: browserFillArgumentsSchema,
    annotations: writes,
  })
  fill(@Payload() args: BrowserFillArguments, @Ctx() context: McpContext) {
    return this.#call(context, (scope) => this.browser.fill(scope, args))
  }

  @ToolScopes(['browser'])
  @Tool({
    name: 'browser_expect',
    description:
      'Check an element of the open page: its state (visible when none is given) or a text it contains. Answers passed true or false.',
    parameters: browserExpectArgumentsSchema,
    annotations: reads,
  })
  expect(@Payload() args: BrowserExpectArguments, @Ctx() context: McpContext) {
    return this.#call(context, (scope) => this.browser.expect(scope, args))
  }

  @ToolScopes(['browser'])
  @Tool({
    name: 'browser_snapshot',
    description:
      'Read the open page as text: its accessibility tree and its links to the preview. Contacts are opaque markers.',
    parameters: browserNoArgumentsSchema,
    annotations: reads,
  })
  snapshot(@Ctx() context: McpContext) {
    return this.#call(context, (scope) => this.browser.snapshot(scope))
  }

  @ToolScopes(['browser'])
  @Tool({
    name: 'browser_screenshot',
    description:
      'Take a screenshot of the open page for the client. The image is kept by the platform; you get only its id, never its pixels.',
    parameters: browserNoArgumentsSchema,
    annotations: { ...reads, idempotentHint: false },
  })
  screenshot(@Ctx() context: McpContext) {
    return this.#call(context, (scope) => this.browser.screenshot(scope))
  }

  @ToolScopes(['browser'])
  @Tool({
    name: 'browser_console',
    description: 'Read the console messages of the open page since the last read.',
    parameters: browserNoArgumentsSchema,
    annotations: { ...reads, idempotentHint: false },
  })
  console(@Ctx() context: McpContext) {
    return this.#call(context, (scope) => this.browser.console(scope))
  }

  @ToolScopes(['browser'])
  @Tool({
    name: 'browser_network',
    description:
      'Read the failed requests of the open page since the last read: errors of the preview by path, requests to any other address as null (they are not let out).',
    parameters: browserNoArgumentsSchema,
    annotations: { ...reads, idempotentHint: false },
  })
  network(@Ctx() context: McpContext) {
    return this.#call(context, (scope) => this.browser.network(scope))
  }

  @ToolScopes(['browser'])
  @Tool({
    name: 'browser_run_checks',
    description:
      'Run up to 10 declarative checks on the preview: each opens a path and expects the status of its page (2xx or 3xx when none is given) and, optionally, an element with its state or text. The platform runs them, not code; the outcome is shown to the client with the candidate.',
    parameters: browserRunChecksArgumentsSchema,
    annotations: { ...reads, idempotentHint: false },
  })
  runChecks(@Payload() args: BrowserRunChecksArguments, @Ctx() context: McpContext) {
    return this.#call(context, (scope) => this.browser.runChecks(scope, args))
  }

  async #call(
    context: McpContext,
    run: (
      scope: NonNullable<McpRequest[typeof MCP_REQUEST_ACCESS]>,
    ) => Promise<BrowserToolResponse>,
  ) {
    const scope = context.getRawRequest<McpRequest>()?.[MCP_REQUEST_ACCESS]
    if (!scope)
      return { isError: true, content: [{ type: 'text', text: 'MCP authorization is required' }] }
    try {
      const response = await run(scope)
      return { content: [{ type: 'text', text: mcpCanonicalJson(response) }] }
    } catch (error) {
      const code =
        isDomainError(error) && agentCodes.has(error.code) ? error.code : 'BROWSER_CALL_REJECTED'
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code }) }] }
    }
  }
}
