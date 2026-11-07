import type { SiteFacts } from '@repo/domain'
import { isNestedSiteRoot } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { bitrixAdapter } from './bitrix.ts'

const site: SiteFacts = {
  stack: 'bitrix',
  url: 'https://shop.example.ru',
  docroot: '/home/bitrix/www',
  extras: {},
}

const notImplemented = expect.objectContaining({ code: 'NOT_IMPLEMENTED' })

describe('bitrixAdapter', () => {
  it('closes both ways: the platform recognises a site of it and connects none', () => {
    expect(bitrixAdapter.support).toEqual({
      files: 'off',
      browser: 'off',
      generations: [],
      refuseBelow: null,
      releaseNeedsChecks: true,
      unknownVersion: 'closed',
    })
    expect(bitrixAdapter.readVersion).toBeNull()
    expect(bitrixAdapter.readLayout).toBeNull()
    expect(bitrixAdapter.driftProbe).toBeNull()
    expect(bitrixAdapter.derivedCopyOf).toBeNull()
    expect(bitrixAdapter.stackGuide(site)).toBe('')
  })

  it('says yes on a front page that loads from /bitrix/, and unknown otherwise', () => {
    const { recognition } = bitrixAdapter
    const front = '<link href="/bitrix/templates/main/styles.css" rel="stylesheet">'
    expect(recognition.fingerprint([{ path: '/', html: front }])).toBe('yes')
    const other = '<link href="/wp-content/themes/a/style.css">'
    expect(recognition.fingerprint([{ path: '/', html: other }])).toBe('unknown')
    expect(recognition.fingerprint([])).toBe('unknown')
    expect(recognition.publicPaths).toEqual([])
    expect(recognition.needsOwnYes).toBe(false)
    expect(recognition.publicGeneration([])).toBeNull()
    expect(recognition.rootHint(['bitrix', 'upload'])).toBeNull()
    expect(recognition.coreFolder).toEqual(['modules', 'php_interface'])
  })

  it('asks for no database and shows no summary panel', () => {
    expect(bitrixAdapter.connection).toEqual({
      databaseEngines: [],
      fullName: '1С-Битрикс',
      adminPathDefault: null,
      shops: [],
      alwaysShop: null,
      pricesGuarded: false,
      configFile: null,
      terms: null,
    })
  })

  it('names the core and the access file of the root, as a copy (Т15)', () => {
    expect(bitrixAdapter.rootMarkers()).toEqual(['bitrix', '.access.php'])
    bitrixAdapter.rootMarkers().length = 0
    expect(bitrixAdapter.rootMarkers()).toEqual(['bitrix', '.access.php'])
    // A folder of component namespaces holds `bitrix` and no `.access.php`.
    expect(isNestedSiteRoot(['bitrix', 'shop'], bitrixAdapter.rootMarkers())).toBe(false)
    expect(isNestedSiteRoot(['bitrix', 'upload', '.access.php'], bitrixAdapter.rootMarkers())).toBe(
      true,
    )
  })

  it('answers no method of the files', async () => {
    for (const call of [
      () => bitrixAdapter.importRules(site),
      () => bitrixAdapter.verify(site),
      () => bitrixAdapter.protectedPaths(site),
      () => bitrixAdapter.agentWorkingSet(site),
      () => bitrixAdapter.mediaRules(site),
      () => bitrixAdapter.previewRecipe(site),
      () => bitrixAdapter.databaseCopyPolicy(site, { previewId: 'preview' }),
    ]) {
      expect(call).toThrow(notImplemented)
    }
    await expect(bitrixAdapter.configSecrets(() => Promise.resolve(null))).rejects.toThrow(
      notImplemented,
    )
  })

  it('carries no change of its database, and tells the agent nothing of one', () => {
    expect(bitrixAdapter.dbOperationKinds(site)).toEqual([])
    expect(bitrixAdapter.dbSettings(site)).toEqual([])
    expect(bitrixAdapter.dbPlanGuide(site)).toBe('')
  })

  it('copies no database, so its preview is unavailable rather than broken', async () => {
    const read = async () => new TextEncoder().encode(`<?php $DBName = "shop";`)
    expect(await bitrixAdapter.databaseSettings(read)).toBeNull()
  })

  it('has no tasks in the browser', () => {
    const ref = { kind: 'post', objectId: '1', editUrl: 'https://shop.example.ru/' } as const
    for (const call of [
      () => bitrixAdapter.browserTaskPolicy({ url: site.url }),
      () => bitrixAdapter.browserCheckpointOf(`${site.url}/bitrix/admin/`),
      () => bitrixAdapter.browserCommitAction('button', 'Сохранить'),
      () => bitrixAdapter.browserVerification(ref),
      () => bitrixAdapter.browserGuide(),
    ]) {
      expect(call).toThrow(notImplemented)
    }
    expect(() => bitrixAdapter.browserGuide()).toThrow('Browser tasks on bitrix')
  })
})
