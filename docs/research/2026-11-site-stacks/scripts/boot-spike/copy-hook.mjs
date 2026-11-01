// Spike: lifts the schema's 64-table limit IN MEMORY, the clone stays untouched. The limit itself is a finding.
import { registerHooks } from 'node:module'
registerHooks({
  load(url, context, next) {
    const out = next(url, context)
    if (url.endsWith('/packages/domain/src/preview/recipe.ts') && process.env.BS_TABLE_LIMIT) {
      const text = String(out.source)
      const patched = text.replace(/\.max\(64\)\n(\s+)\.refine\(\n\s+\(tables\)/, (m) => m.replace('.max(64)', `.max(${process.env.BS_TABLE_LIMIT})`))
      if (patched === text) throw new Error('the limit was not found')
      return { ...out, source: patched }
    }
    return out
  },
})
