import { describe, expect, it } from 'vitest'

import {
  backupKeyObject,
  backupObject,
  dbValueObject,
  feedReasonOf,
  hostingAccessKind,
  installedBaseOf,
  releaseErrorOfReport,
  releaseErrors,
} from './release-row.ts'

const SITE = '0199B2F4-6C1E-7A52-9F3D-2B8E4C7D1A60'
const RELEASE = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61'

describe('the row of a release', () => {
  it('keeps the objects of an attempt under the site, the release and the attempt', () => {
    const prefix = `sites/${SITE.toLowerCase()}/${RELEASE}/2`
    expect(backupObject(SITE, RELEASE, 2)).toBe(`${prefix}/backup.tar.zst.enc`)
    expect(backupKeyObject(SITE, RELEASE, 2)).toBe(`${prefix}/backup.key`)
    expect(dbValueObject(SITE, RELEASE, 2, 0)).toBe(`${prefix}/db/0.bin`)
  })

  it('writes to the hosting through SFTP or FTP only', () => {
    expect(hostingAccessKind('sftp')).toBe('ssh')
    expect(hostingAccessKind('ftp')).toBe('ftp')
    expect(hostingAccessKind('git')).toBeNull()
  })

  it('compares with what the hosting holds: the installed version, else `main` as found', () => {
    expect(
      installedBaseOf({ installedBeforeSha: 'a'.repeat(40), mainBeforeSha: 'b'.repeat(40) }),
    ).toBe('a'.repeat(40))
    expect(installedBaseOf({ installedBeforeSha: null, mainBeforeSha: 'b'.repeat(40) })).toBe(
      'b'.repeat(40),
    )
  })

  it('keeps the code of the job in words, never a message', () => {
    expect(releaseErrorOfReport({ state: 'failed', detail: { code: 'conflict' } })).toBe('conflict')
    expect(releaseErrorOfReport({ state: 'failed', detail: { code: 'site_broken' } })).toBe(
      releaseErrors.verifyFailed,
    )
    expect(releaseErrorOfReport({ state: 'unknown', detail: { code: 'write_failed' } })).toBe(
      'write_failed',
    )
    // A code the job does not have is not kept.
    expect(releaseErrorOfReport({ state: 'failed', detail: { code: 'oops_whatever' } })).toBe(
      releaseErrors.stepFailed,
    )
    expect(releaseErrorOfReport({ state: 'unknown', detail: {} })).toBe(releaseErrors.stepUnknown)
    expect(releaseErrorOfReport({ state: 'started', detail: { code: 'conflict' } })).toBeNull()
    expect(releaseErrorOfReport({ state: 'succeeded', detail: {} })).toBeNull()
  })

  it('tells the client why, in its own terms', () => {
    expect(feedReasonOf('installed', null)).toBeNull()
    expect(feedReasonOf('unknown', releaseErrors.stepUnknown)).toBeNull()
    expect(feedReasonOf('refused', releaseErrors.outdated)).toBe('outdated')
    expect(feedReasonOf('refused', releaseErrors.mainMoved)).toBe('outdated')
    expect(feedReasonOf('refused', releaseErrors.notAllowed)).toBe('not_allowed')
    expect(feedReasonOf('refused', releaseErrors.checksFailed)).toBe('checks_failed')
    expect(feedReasonOf('refused', releaseErrors.siteInactive)).toBe('site_inactive')
    expect(feedReasonOf('refused', releaseErrors.clientVariable)).toBe('client_variable')
    expect(feedReasonOf('failed', releaseErrors.clientVariable)).toBe('client_variable')
    expect(feedReasonOf('refused', releaseErrors.publishTimeout)).toBe('technical')
    expect(feedReasonOf('failed', releaseErrors.secretRefused)).toBe('technical')
    expect(feedReasonOf('failed', releaseErrors.conflict)).toBe('conflict')
    expect(feedReasonOf('failed', releaseErrors.startTimeout)).toBe('not_started')
    expect(feedReasonOf('rolled_back', releaseErrors.verifyFailed)).toBe('site_check')
    // The site failed its check before the job wrote anything (R8c): not a technical fault.
    expect(releaseErrorOfReport({ state: 'failed', detail: { code: 'site_broken_before' } })).toBe(
      'site_broken_before',
    )
    expect(feedReasonOf('failed', 'site_broken_before')).toBe('site_broken_before')
    // A code cache no check could see through (R12): the operator's word, a technical fault to
    // the client.
    expect(releaseErrorOfReport({ state: 'failed', detail: { code: 'code_cache' } })).toBe(
      'code_cache',
    )
    expect(feedReasonOf('failed', 'code_cache')).toBe('technical')
    expect(feedReasonOf('failed', releaseErrors.tagTaken)).toBe('technical')
    expect(feedReasonOf('rolled_back', null)).toBe('technical')
  })
})
