import { z } from 'zod'

// The order of the list of projects (docs/plan/84-projects.md, ПР4, ПР30): the tabs, the sorts and
// one comparison the database reading and the cabinet share.

/** «Все», «Избранное», «Архив» and «Корзина» (ПР4). */
export const projectListViews = ['all', 'starred', 'archive', 'trash'] as const
export type ProjectListView = (typeof projectListViews)[number]

/** «Недавние», «По названию», «По дате создания» (ПР4). */
export const projectListSorts = ['recent', 'name', 'created'] as const
export type ProjectListSort = (typeof projectListSorts)[number]

export const projectListViewSchema = z.enum(projectListViews)
export const projectListSortSchema = z.enum(projectListSorts)

/** What the order reads of a project. */
export interface ProjectOrderFacts {
  id: string
  name: string
  activityAt: Date
  createdAt: Date
  starredAt: Date | null
}

const byName = new Intl.Collator('ru', { sensitivity: 'base', numeric: true })

/**
 * The order of a list: the latest activity first (`recent`, the default), by the name as a Russian
 * reader sorts it (`name`), or the latest created first (`created`); the id breaks a tie, so the
 * order is the same every time. `starredFirst` — the menu of the field (ПР30): the starred
 * projects stand before the others, each part in the order of the sort.
 */
export function compareProjects(
  sort: ProjectListSort = 'recent',
  options: { starredFirst?: boolean } = {},
): (a: ProjectOrderFacts, b: ProjectOrderFacts) => number {
  return (a, b) => {
    if (options.starredFirst) {
      const starred = Number(b.starredAt !== null) - Number(a.starredAt !== null)
      if (starred !== 0) return starred
    }
    const order =
      sort === 'name'
        ? byName.compare(a.name, b.name)
        : sort === 'created'
          ? b.createdAt.getTime() - a.createdAt.getTime()
          : b.activityAt.getTime() - a.activityAt.getTime()
    if (order !== 0) return order
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
}
