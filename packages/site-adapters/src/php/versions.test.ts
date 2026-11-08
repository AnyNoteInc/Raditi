import { describe, expect, it } from 'vitest'
import { wordpressPhpVersions } from '../wordpress-preview.ts'
import { phpVersionNumber, phpVersionsNear } from './versions.ts'

describe('phpVersionNumber', () => {
  it.each([
    ['8.3', 803],
    ['7.4.33', 704],
    ['8.10', 810],
    ['5.6', 506],
  ])('reads %s as %d', (version, number) => {
    expect(phpVersionNumber(version)).toBe(number)
  })

  it.each(['', 'php', '8', '8.3a', '123.4', 'v8.3'])('reads %j as no version', (version) => {
    expect(phpVersionNumber(version)).toBeNull()
  })
})

describe('phpVersionsNear', () => {
  const joomla3 = ['7.4', '7.3', '8.0'] as const

  it('keeps the order of the list without a version of the site', () => {
    expect(phpVersionsNear(joomla3, undefined)).toEqual(['7.4', '7.3', '8.0'])
    expect(phpVersionsNear(joomla3, 'php')).toEqual(['7.4', '7.3', '8.0'])
  })

  it('puts the nearest first and the older of two equally near before the newer', () => {
    expect(phpVersionsNear(joomla3, '5.6')).toEqual(['7.3', '7.4', '8.0'])
    expect(phpVersionsNear(['8.0', '8.2'], '8.1.31')).toEqual(['8.0', '8.2'])
    expect(phpVersionsNear(['8.2', '8.0'], '8.1')).toEqual(['8.0', '8.2'])
  })

  it('does not change the list it is given', () => {
    const list = ['8.3', '8.4', '8.5']
    phpVersionsNear(list, '8.5')
    expect(list).toEqual(['8.3', '8.4', '8.5'])
  })

  // The order WordPress took before the order moved here, on the versions of
  // wordpress-preview.test.ts and a few more: recorded from the code of 9b0fdc2c.
  it.each([
    [undefined, ['8.3', '8.2', '8.4', '8.1', '8.5', '8.0', '7.4']],
    ['8.1.31', ['8.1', '8.0', '8.2', '8.3', '8.4', '8.5', '7.4']],
    ['7.2', ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5']],
    ['9.1', ['8.5', '8.4', '8.3', '8.2', '8.1', '8.0', '7.4']],
    ['php', ['8.3', '8.2', '8.4', '8.1', '8.5', '8.0', '7.4']],
    ['8.2', ['8.2', '8.1', '8.3', '8.0', '8.4', '8.5', '7.4']],
    ['7.4', ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5']],
    ['5.6', ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5']],
  ] as const)('keeps the order of WordPress for %s', (version, order) => {
    expect(wordpressPhpVersions(version)).toEqual(order)
  })
})
