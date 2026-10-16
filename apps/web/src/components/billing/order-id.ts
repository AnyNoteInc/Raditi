import { z } from 'zod'

// The same check as the input of billing.syncOrder.
const orderIdSchema = z.uuid()

/**
 * The order a return link names: the value of its `order` parameter when it is the id of an
 * order, null otherwise — the parameter is missing, repeated or not an id. For such a link
 * the page shows «not found» without asking the server.
 */
export function orderIdFromQuery(value: string | string[] | undefined): string | null {
  const parsed = orderIdSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
