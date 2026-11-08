import { z } from 'zod'

/** The longest query `search_web` takes: a short phrase of public words, not a text. */
export const WEB_SEARCH_QUERY_MAX = 200

/**
 * The arguments of `search_web`: one short search phrase. The policy of the endpoint checks the
 * same schema before mcp-nest sees the call, so a refused call never reaches the tool.
 */
export const webSearchArgumentsSchema = z.strictObject({
  query: z
    .string()
    .trim()
    .min(2)
    .max(WEB_SEARCH_QUERY_MAX)
    // eslint-disable-next-line no-control-regex -- the phrase is one line without control characters
    .refine((query) => !/[\u0000-\u001f\u007f]/.test(query), 'one line of text'),
})
export type WebSearchArguments = z.infer<typeof webSearchArgumentsSchema>
