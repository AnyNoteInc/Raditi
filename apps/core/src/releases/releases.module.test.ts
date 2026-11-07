import type { FactoryProvider, Provider } from '@nestjs/common'
import { getSiteAdapter } from '@repo/site-adapters'
import { describe, expect, it } from 'vitest'

import type { CoreConfig } from '../config/config.ts'
import { contentAccessKindOf } from '../site-content/site-access.ts'
import { ReleaseSkill, type ReleaseSkillDependencies } from './release-skill.ts'
import { ReleasesModule, releaseSkillStacks } from './releases.module.ts'

/** The release skill as the module's own factory builds it, its other dependencies stubbed. */
function releaseSkillOfModule(): ReleaseSkillDependencies {
  const providers = (Reflect.getMetadata('providers', ReleasesModule) ?? []) as Provider[]
  const provider = providers.find(
    (one): one is FactoryProvider => typeof one === 'object' && one.provide === ReleaseSkill,
  )
  if (!provider) throw new Error('ReleasesModule provides no ReleaseSkill factory')
  const config = { releaseApi: null, previews: null } as unknown as CoreConfig
  const stub = {} as never
  const skill: unknown = provider.useFactory(
    stub,
    stub,
    null,
    null,
    stub,
    stub,
    config,
    stub,
    () => stub,
  )
  expect(skill).toBeInstanceOf(ReleaseSkill)
  // The dependencies are the skill's own; read here only to see what the factory gave it.
  return (skill as { deps: ReleaseSkillDependencies }).deps
}

describe('ReleasesModule: the adapters of the stacks', () => {
  it('reads the plugin of a stack by the one rule of core (Т8)', () => {
    expect(releaseSkillStacks.adapter).toBe(getSiteAdapter)
    expect(releaseSkillStacks.contentAccessKind).toBe(contentAccessKindOf)
    // Bitrix has no content adapter: a release of its site with a plan is refused, not an error.
    expect(releaseSkillStacks.contentAccessKind('bitrix')).toBeNull()
  })

  it('gives the skill its factory builds that rule, not one of its own', () => {
    const deps = releaseSkillOfModule()
    expect(deps.adapter).toBe(getSiteAdapter)
    expect(deps.contentAccessKind).toBe(contentAccessKindOf)
    expect(deps.contentAccessKind('bitrix')).toBeNull()
    expect(deps.contentAccessKind('wordpress')).toBe(contentAccessKindOf('wordpress'))
    expect(deps.contentAccessKind('wordpress')).not.toBeNull()
  })
})
