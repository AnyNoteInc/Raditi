import { readChatTodo, type PrismaClient } from '@repo/db'
import { chatTodoOf, chatTodoSchema, type ChatTodo } from '@repo/domain'

import { accessibleTask, taskNotFound } from './access.ts'

// «План работы» beside the chat (docs/plan/87-agent-todos.md, ТД4, ТД5, §5.3): the agent's to-do
// list as the card shows it — a snapshot, no cursor. The list is read from the journal of the last
// two counted turns; which of them the card shows, and in what state, is the domain's.

/** `task.todo` for a member of the chat's workspace; null — no plan to show. */
export async function chatTodo(
  db: Pick<PrismaClient, 'task' | '$queryRaw'>,
  input: { userId: string; taskId: string },
): Promise<ChatTodo | null> {
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, input.taskId),
    select: { id: true },
  })
  if (task === null) throw taskNotFound()
  const { latest, previous } = await readChatTodo(db, task.id)
  return chatTodoSchema.nullable().parse(chatTodoOf(latest, previous))
}
