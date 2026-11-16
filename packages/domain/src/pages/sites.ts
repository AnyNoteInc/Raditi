import { pageLimits } from './limits.ts'

/**
 * Sites of pages a workspace may have (docs/plan/73-pages-sites.md, Дер36; the owner's request of
 * 16.11.2026): «Старт» 20, «Бизнес» 100, «Агентство» 200 — `plans.page_sites` of the tariff
 * the workspace pays for; without a paid tariff — `sitesWithoutTariff`. A site is any host, one of
 * a single page too (В13); the trash does not count. The limit stops a new site only: sites over
 * it after a lower tariff keep answering (Дер1).
 */
export function pageSitesLimit(plan: { pageSites: number | null } | null): number {
  return plan?.pageSites ?? pageLimits.sitesWithoutTariff
}

/**
 * Whether the workspace may give a site its own name, `<name>.pages.raditi.ru` (Дер32; В3: «только
 * на тарифе бизнес и выше»): `plans.page_custom_names` of the tariff it pays for.
 */
export function pageCustomNamesAllowed(plan: { pageCustomNames: boolean } | null): boolean {
  return plan?.pageCustomNames ?? false
}
