import { z } from 'zod'

/**
 * How a preview differs from the real site (docs/plan/62-site-stacks.md, Т34): one value per row
 * of its table. Web and mcp read the passport, so it lives in the domain and not in apps/core.
 */
export const previewDifferences = [
  'code_drift',
  'php_differs',
  'php_unknown',
  'home_differs',
  'redirects_away',
  'media_on_hosting',
  'media_placeholders',
  'extension_data_left_out',
  'files_left_out',
  'documents_left_out',
  'encoded_code',
  'external_cache',
  'partial_site',
  'server_rules_default',
  'seed_from_dump',
  'live_edits',
  'secrets_masked',
  'other_system_left_out',
] as const
export type PreviewDifference = (typeof previewDifferences)[number]

/**
 * What the platform found about a built preview (Т33, Т34). `boot`: `proved` — it answered as
 * the real site does, `suspect` — it answered, but nothing proves it is the site (a closed page,
 * a redirect to another host, no answer to read), `not_compared` — alive, not compared with the
 * real site yet. A site that did not start has no passport: its preview is `boot_failed`.
 */
export const previewPassportSchema = z.strictObject({
  boot: z.enum(['proved', 'suspect', 'not_compared']),
  differences: z.array(z.enum(previewDifferences)).max(24),
  checkedAt: z.iso.datetime(),
})
export type PreviewPassport = z.infer<typeof previewPassportSchema>
