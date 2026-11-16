import type { AppRouter } from '@repo/trpc'
import type { inferRouterOutputs } from '@trpc/server'

type Outputs = inferRouterOutputs<AppRouter>

/** A project of a tab of «Проекты», as `project.list` sends it. */
export type ProjectListItem = Outputs['project']['list']['items'][number]
/** A project for its page, as `project.get` sends it. */
export type ProjectDetails = Outputs['project']['get']

/** What the field of a new chat knows of the project it starts in (ПР30). */
export interface PickedProject {
  id: string
  name: string
  goal: string | null
  hasInstructions: boolean
  /**
   * The project of the address before the list of projects has come: its id is sent as it is,
   * and the server decides whose it is; what it is called the field does not know yet.
   */
  pending?: true
}

export const pickedOf = (
  project: Pick<ProjectListItem, 'id' | 'name' | 'goal' | 'hasInstructions'>,
): PickedProject => ({
  id: project.id,
  name: project.name,
  goal: project.goal,
  hasInstructions: project.hasInstructions,
})
