import { describe, expect, it } from 'vitest'
import { bitrixAdapter } from '../bitrix.ts'
import { neutralPublicPages } from '../testing/contract.ts'
import { JOOMLA_MANIFEST_URL } from './joomla-version.ts'
import {
  administratorNames,
  bitrixRemainsHome,
  drupalGeneratorHome,
  emptyHome,
  joomla3Home,
  joomlaGeneratorHome,
  juiHome,
  juiWithWordpressGeneratorHome,
  manifest2528,
  manifest31012,
  manifest620,
  manifestPage,
  publicFolderNames,
  root310Names,
  root620Names,
  vendorHome,
  wordpressGeneratorHome,
  wordpressRemainsHome,
} from './fixtures.ts'
import { joomlaConnection, joomlaRecognition } from './joomla-recognition.ts'
import { joomlaGenerations } from './joomla-support.ts'

const { fingerprint, publicGeneration, rootHint } = joomlaRecognition

const homePage = (html: string) => ({ path: '/', html })
const atManifest = (html: string) => ({ path: JOOMLA_MANIFEST_URL, html })

describe('joomlaRecognition.fingerprint', () => {
  it.each([
    ['the manifest', manifestPage(manifest620)],
    ['the tag generator', joomlaGeneratorHome],
    ['/media/jui/', juiHome],
    ['/media/vendor/ beside /media/system/', vendorHome],
    ['the home of Joomla 3', joomla3Home],
  ])('says yes on %s', (_, page) => {
    expect(fingerprint([page])).toBe('yes')
  })

  it('says yes when the tag of WordPress stands next to /media/jui/: its own sign wins', () => {
    expect(fingerprint([juiWithWordpressGeneratorHome])).toBe('yes')
  })

  it('says yes on the manifest even when the home page has the tag of WordPress', () => {
    expect(fingerprint([wordpressGeneratorHome, manifestPage(manifest31012)])).toBe('yes')
  })

  it.each([
    ['WordPress', wordpressGeneratorHome],
    ['Drupal', drupalGeneratorHome],
  ])('says no on a home page with the tag generator of %s', (_, page) => {
    expect(fingerprint([page])).toBe('no')
  })

  it.each([
    ['/bitrix/', bitrixRemainsHome],
    ['/wp-content/', wordpressRemainsHome],
  ])('says unknown on links to %s an old site left in src and href', (_, page) => {
    expect(fingerprint([page])).toBe('unknown')
  })

  it.each(neutralPublicPages.map((page, i) => [i, page] as const))(
    'says unknown on the neutral page %i',
    (_, page) => {
      expect(fingerprint([page])).toBe('unknown')
    },
  )

  it('says unknown on an empty page and without pages', () => {
    expect(fingerprint([emptyHome])).toBe('unknown')
    expect(fingerprint([])).toBe('unknown')
  })

  it('does not take /media/vendor/ alone for Joomla', () => {
    const page = { path: '/', html: '<script src="/media/vendor/x.js"></script>' }
    expect(fingerprint([page])).toBe('unknown')
  })

  it('does not take /media/system/ alone for Joomla', () => {
    const page = homePage('<script src="/media/system/js/core.min.js"></script>')
    expect(fingerprint([page])).toBe('unknown')
    expect(publicGeneration([page])).toBeNull()
  })

  it.each([
    ['/media/jui/ of another host', '<img src="https://partner.example/media/jui/img/x.png">'],
    [
      '/media/vendor/ and /media/system/ of another host',
      '<script src="https://cdn.example/media/vendor/x.js"></script>' +
        '<script src="//cdn.example/media/system/js/core.js"></script>',
    ],
    [
      'a sub-path that ends in /media/vendor/',
      '<script src="/wp-content/plugins/x/media/vendor/x.js"></script>' +
        '<script src="/media/system/js/core.min.js"></script>',
    ],
    ['words in the text', '<p>Папки /media/jui/, /media/system/ и /media/vendor/</p>'],
  ])('does not take %s for an asset of this site', (_, body) => {
    expect(fingerprint([homePage(body)])).toBe('unknown')
    expect(publicGeneration([homePage(body)])).toBeNull()
    const withWordpress = homePage(`<meta name="generator" content="WordPress 6.8">${body}`)
    expect(fingerprint([withWordpress])).toBe('no')
  })

  it.each(neutralPublicPages.map((page, i) => [i, page] as const))(
    'does not take the neutral page %i at the address of the manifest for the manifest',
    (_, page) => {
      expect(fingerprint([atManifest(page.html)])).toBe('unknown')
      expect(fingerprint([emptyHome, atManifest(page.html)])).toBe('unknown')
      expect(fingerprint([wordpressGeneratorHome, atManifest(page.html)])).toBe('no')
      expect(publicGeneration([atManifest(page.html)])).toBeNull()
    },
  )

  it('does not take the home page served at the address of the manifest for the manifest', () => {
    const soft404 = atManifest(wordpressGeneratorHome.html)
    expect(fingerprint([wordpressGeneratorHome, soft404])).toBe('no')
    expect(publicGeneration([soft404])).toBeNull()
  })

  it('does not take a page of another path for the manifest', () => {
    expect(fingerprint([{ path: '/robots.txt', html: manifest620 }])).toBe('unknown')
  })

  it('control: on the remains of /bitrix/ Bitrix says yes and Joomla unknown', () => {
    expect(bitrixAdapter.recognition.fingerprint([bitrixRemainsHome])).toBe('yes')
    expect(fingerprint([bitrixRemainsHome])).toBe('unknown')
  })
})

describe('joomlaRecognition.publicGeneration', () => {
  it.each([
    ['2.5.28', manifest2528, 'j30'],
    ['3.10.12', manifest31012, 'j3'],
    ['6.2.0', manifest620, 'j6'],
  ])('gives the branch of the manifest %s', (_, text, id) => {
    expect(publicGeneration([manifestPage(text)])).toBe(id)
  })

  it('gives null for a version past the table', () => {
    const text = manifest620.replace('<version>6.2.0</version>', '<version>7.0.0</version>')
    expect(publicGeneration([manifestPage(text)])).toBeNull()
  })

  it('gives j3 for /media/jui/ without a manifest', () => {
    expect(publicGeneration([juiHome])).toBe('j3')
  })

  it('gives null without a sign of the branch', () => {
    expect(publicGeneration([joomlaGeneratorHome])).toBeNull()
    expect(publicGeneration([vendorHome])).toBeNull()
    expect(publicGeneration([])).toBeNull()
  })

  it('closes the panel of Joomla 2.5: the branch j30 has no browser and no files', () => {
    const id = publicGeneration([manifestPage(manifest2528)])
    const row = joomlaGenerations.find((generation) => generation.id === id)
    expect(row).toMatchObject({ id: 'j30', browser: false, files: 'off' })
  })

  it('judges by /media/jui/ when the version of the manifest is not a version', () => {
    const text = manifest620.replace('<version>6.2.0</version>', '<version>6.2.0;rm-rf</version>')
    expect(publicGeneration([manifestPage(text), juiHome])).toBe('j3')
    expect(publicGeneration([manifestPage(text)])).toBeNull()
  })

  it('never gives a string of the site', () => {
    const text = manifest620.replace('<version>6.2.0</version>', '<version>6.2.0-evil</version>')
    expect(publicGeneration([manifestPage(text)])).toBe('j6')
  })
})

describe('joomlaRecognition.rootHint', () => {
  it('says outside_root on the public folder of 5.0+, in any case of the names', () => {
    expect(rootHint(publicFolderNames)).toBe('outside_root')
    expect(rootHint(publicFolderNames.map((name) => name.toUpperCase()))).toBe('outside_root')
  })

  it('says nothing on a root of 3.10 and 6.2, on a root with libraries and defines.php, on administrator/', () => {
    expect(rootHint(root310Names)).toBeNull()
    expect(rootHint(root620Names)).toBeNull()
    expect(rootHint([...root620Names, 'defines.php'])).toBeNull()
    expect(rootHint(administratorNames)).toBeNull()
  })

  it('never says renamed_folder', () => {
    const renamed = publicFolderNames.filter((name) => name !== 'administrator')
    expect(rootHint(renamed)).toBeNull()
  })
})

describe('joomlaRecognition', () => {
  it('reads the manifest from outside and needs no own yes', () => {
    expect(joomlaRecognition.publicPaths).toEqual(['/administrator/manifests/files/joomla.xml'])
    expect(joomlaRecognition.needsOwnYes).toBe(false)
    expect(joomlaRecognition.coreFolder).toBeNull()
  })
})

describe('joomlaConnection', () => {
  it('carries the row of Joomla of the table Т27 byte for byte', () => {
    expect(joomlaConnection.terms).toEqual({
      copy: 'Код и стили агент меняет в копии: вы смотрите предпросмотр и сами выпускаете правку, её можно отменить в течение 7 дней.',
      copyDetail: 'Оформление, шаблоны, подписи на страницах.',
      live: 'Тексты и новости агент меняет сразу на сайте, и отменить это мы не сможем.',
      liveDetail: 'Статьи, категории, картинки, текстовые блоки.',
      closed: [
        'Меню, формы, пользователи, настройки и права доступа. Удаление статей и категорий.',
      ],
    })
    expect(joomlaConnection.terms?.closed).toHaveLength(1)
  })

  it('names configuration.php in the hint of the step of the database', () => {
    expect(joomlaConnection.configFile).toBe('configuration.php')
  })

  it('offers MySQL only, the panel at /administrator/ and the name Joomla', () => {
    expect(joomlaConnection.databaseEngines).toEqual(['mysql'])
    expect(joomlaConnection.adminPathDefault).toBe('/administrator/')
    expect(joomlaConnection.fullName).toBe('Joomla')
  })

  it('is not a shop by itself and closes the products of every shop: the third text of Т32', () => {
    expect(joomlaConnection.alwaysShop).toBeNull()
    expect(joomlaConnection.shops.length).toBeGreaterThan(0)
    expect(joomlaConnection.shops.every((shop) => shop.products === 'closed')).toBe(true)
    expect(joomlaConnection.pricesGuarded).toBe(false)
  })
})
