import { pageSiteStates, pageSiteStats, type PageSiteState, type PrismaClient } from '@repo/db'
import { Gauge, type Registry } from '@prometheus-io/client'

/**
 * The metrics of the sites of pages (docs/plan/73-pages-sites.md, 73.12): how many sites there are
 * by state and how many bytes the trash holds — numbers of the whole platform, never of a
 * workspace, so no id is a label. The sweep of core counts them once a pass (`refresh`); a scrape
 * reads the last count, it never queries the database.
 */
export class PageMetrics {
  #sites: Record<PageSiteState, number> | null = null
  #trashBytes: number | null = null

  constructor(private readonly db: Pick<PrismaClient, '$queryRaw'>) {}

  /** Counts again; a failed count keeps the last one. */
  async refresh(): Promise<void> {
    const stats = await pageSiteStats(this.db)
    this.#sites = stats.sites
    this.#trashBytes = stats.trashBytes
  }

  register(registry: Registry): void {
    const sites = () => this.#sites
    const trash = () => this.#trashBytes
    new Gauge({
      name: 'raditi_pages_trees',
      help: 'Sites of pages by the state of their home page; purged — a tombstone of its address',
      labelNames: ['state'],
      registers: [registry],
      collect() {
        const counted = sites()
        if (counted === null) return
        for (const state of pageSiteStates) this.set({ state }, counted[state])
      },
    })
    new Gauge({
      name: 'raditi_pages_trash_bytes',
      help: 'Bytes the pages in the trash still hold until they are returned or purged',
      registers: [registry],
      collect() {
        const bytes = trash()
        if (bytes !== null) this.set(bytes)
      },
    })
  }
}
