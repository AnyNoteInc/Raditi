import type { Prisma } from './generated/prisma/client.ts'

/**
 * Whether a task left content writes on the production site that nothing gave back (spec §11):
 * an applied call of the agent in `mcp_calls`, not into a preview, not a restore of the trusted
 * host, and not reverted. A dialog of the chat writes into its preview (docs/plan/53, Р3), so
 * this is the case of a dialog without a preview row; whoever closes such a task tells the
 * client to check the site (`feed.cancelled.site = 'check'`) instead of «unchanged». A task in
 * the cloud browser counts too once anyone clicked, typed or uploaded in its browser
 * (`browser_sessions.wrote_at`, docs/plan/57-browser-tasks.md, Б28): nothing gives that back.
 * With `turnNo` — the writes of that one turn (the undo before its replacement); a browser
 * session belongs to the task, not to a turn, and no undo returns what it did.
 */
export async function taskHasProductionWrites(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  taskId: string,
  options: { turnNo?: number } = {},
): Promise<boolean> {
  const turnNo = options.turnNo ?? null
  const rows = await tx.$queryRaw<Array<{ writes: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM mcp_calls m JOIN task_turns tt ON tt.id = m.turn_id
      WHERE tt.task_id = ${taskId}::uuid AND m.preview_id IS NULL AND m.host_task_id IS NULL
        AND m.applied_state_hash IS NOT NULL AND m.reverted_at IS NULL
        AND (${turnNo}::int IS NULL OR tt.turn_no = ${turnNo}::int)
    ) OR (${turnNo}::int IS NULL AND EXISTS (
      SELECT 1 FROM browser_sessions b
      WHERE b.task_id = ${taskId}::uuid AND b.wrote_at IS NOT NULL
    )) AS writes`
  return rows[0]?.writes === true
}
