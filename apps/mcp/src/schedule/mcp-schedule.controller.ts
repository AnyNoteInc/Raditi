import { Inject } from '@nestjs/common'
import { Ctx, Payload } from '@nestjs/microservices'
import { McpController, Tool, ToolScopes, type McpContext } from '@rekog/mcp-nest'

import { MCP_REQUEST_ACCESS, type McpRequest } from '../access/mcp-request.ts'
import { mcpCanonicalJson } from '../common/canonical-json.ts'
import {
  scheduleCreateToolArgumentsSchema,
  scheduleDeleteToolArgumentsSchema,
  scheduleListToolArgumentsSchema,
  scheduleUpdateToolArgumentsSchema,
} from './schedule-arguments.ts'
import type { McpScheduleAnswer, McpScheduleService } from './schedule-service.ts'
import { MCP_SCHEDULE } from './schedule.tokens.ts'

const answerOf = (answer: McpScheduleAnswer) =>
  answer.ok
    ? { content: [{ type: 'text', text: mcpCanonicalJson(answer) }] }
    : { isError: true, content: [{ type: 'text', text: JSON.stringify(answer) }] }

const unauthorized = {
  isError: true,
  content: [{ type: 'text', text: 'MCP authorization is required' }],
}

const reads = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const writes = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}

const scopeOf = (context: McpContext) => context.getRawRequest<McpRequest>()?.[MCP_REQUEST_ACCESS]

/** Said once in every tool that changes a task. */
const AT_THE_END =
  'The change goes live when this turn ends: say «Задача появится, как только я закончу ответ» (or that it changes then), never that it is done already. A refusal comes back as ok: false with a code and words: explain it to the client in your own words and never report it as a success.'

/** What the agent recaps and the client agrees to before a change (Зп34). */
const AGREED =
  'Call it only after the client agreed in this chat, in their own words, to the exact recap you gave — the name, the exact instructions, the project, «Размышление» and the schedule with its timezone — and then set confirmedByClient: true. Never invent a time the client did not name: ask.'

/**
 * The scheduled tasks of the chat's author (docs/plan/82-scheduled-tasks.md, Зп31–Зп34): the
 * family `schedule` — `schedule_list` — for every turn, and `schedule_changes` — the creation, the
 * change and the deletion — for a turn the client watches (`@ToolScopes`, mcpToolFamiliesOf): a
 * pass of a scheduled run without its client sees the list alone (Зп32). A task runs by itself on
 * its schedule: each run is a new chat with its instructions as the client's message. Every change
 * is reserved now and applied when the turn ends (Зп33); the descriptions are the model's, in
 * English (Ст20).
 */
@McpController()
export class McpScheduleController {
  constructor(@Inject(MCP_SCHEDULE) private readonly schedules: McpScheduleService) {}

  @ToolScopes(['schedule'])
  @Tool({
    name: 'schedule_list',
    description:
      "The scheduled tasks of the client — the author of this chat — of this chat's project (in a chat without a project: those without one): each with scheduleId, its name, the exact instructions, «Размышление» (effort), the schedule in words and as triggers, its timezone, its state (enabled, paused, completed, or why it stopped), the next run and the last one; the changes this turn reserved and core has not applied yet (reservedThisTurn); the time now and the client's timezone with the wall clock there. A scheduled task runs by itself: at each run the agent gets its instructions as the client's message in a new chat. Look here before schedule_create: change a task the client has rather than make a second one.",
    parameters: scheduleListToolArgumentsSchema,
    annotations: reads,
  })
  async list(@Payload() args: unknown, @Ctx() context: McpContext) {
    const scope = scopeOf(context)
    if (!scope) return unauthorized
    return answerOf(await this.schedules.list(scope, args))
  }

  @ToolScopes(['schedule_changes'])
  @Tool({
    name: 'schedule_create',
    description: `Set up a scheduled task for the client: at each run the agent does its instructions by itself in a new chat, while the client is away, and the client is notified. Write the instructions as the client's own request, in their words, with nothing of the schedule inside (the schedule is triggers). project is this_chat in a chat of a project and none in a chat without one; a task about a site is not set up in a chat without a project — offer a chat of its project or the section «Запланированные задачи» instead. Runs of one task are at least an hour apart; at most 20 enabled tasks a workspace and 5 changes a turn. ${AGREED} ${AT_THE_END} The answer gives reservedId — schedule_update or schedule_delete of it in this turn changes or cancels the reservation —, the schedule in words and the next run.`,
    parameters: scheduleCreateToolArgumentsSchema,
    annotations: writes,
  })
  async create(@Payload() args: unknown, @Ctx() context: McpContext) {
    const scope = scopeOf(context)
    if (!scope) return unauthorized
    return answerOf(await this.schedules.create(scope, args))
  }

  @ToolScopes(['schedule_changes'])
  @Tool({
    name: 'schedule_update',
    description: `Change a scheduled task of schedule_list (scheduleId) or a change this turn reserved (reservedId): its name, instructions, «Размышление», triggers, timezone, notifications, or enabled — false pauses it, true resumes it. Give only what changes. ${AGREED} ${AT_THE_END}`,
    parameters: scheduleUpdateToolArgumentsSchema,
    annotations: writes,
  })
  async update(@Payload() args: unknown, @Ctx() context: McpContext) {
    const scope = scopeOf(context)
    if (!scope) return unauthorized
    return answerOf(await this.schedules.update(scope, args))
  }

  @ToolScopes(['schedule_changes'])
  @Tool({
    name: 'schedule_delete',
    description: `Delete a scheduled task of schedule_list (scheduleId) when this turn ends — only when the client asked in this chat, in their own words, to delete it; the chats of its past runs stay. With reservedId it cancels a change this turn reserved, at once. Set confirmedByClient: true only after the client agreed to deleting exactly this task, named. ${AT_THE_END}`,
    parameters: scheduleDeleteToolArgumentsSchema,
    annotations: { ...writes, destructiveHint: true },
  })
  async delete(@Payload() args: unknown, @Ctx() context: McpContext) {
    const scope = scopeOf(context)
    if (!scope) return unauthorized
    return answerOf(await this.schedules.delete(scope, args))
  }
}
