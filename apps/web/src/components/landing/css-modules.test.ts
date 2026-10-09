import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { MOVE_MS, RISE_PX } from './motion'

// A CSS module reports neither a class that no markup uses nor a `styles.x` that no rule
// defines (it is just undefined). This keeps the two lists equal for the landing modules.
// It also holds the three modules to one discipline of states: a hover only where the device
// hovers, keyboard and press states outside that query, a move only where motion is welcome.
// And to one system of motion: every time and curve from the scale, one block of reduced motion,
// a short list of animated properties.

const here = fileURLToPath(new URL('.', import.meta.url))
const files = readdirSync(here).sort()
const modules = files.filter((name) => name.endsWith('.module.css'))
const components = files.filter((name) => name.endsWith('.tsx') && !name.includes('.test.'))
const read = (name: string) => readFileSync(`${here}${name}`, 'utf8')

/** Class names of the selectors; declarations and at-rule preludes are left out. */
function classesOf(css: string): Set<string> {
  const names = new Set<string>()
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const [, prelude = ''] of source.matchAll(/([^{};]+)\{/g)) {
    if (prelude.trim().startsWith('@')) continue
    for (const [, name = ''] of prelude.matchAll(/\.([A-Za-z_][\w-]*)/g)) names.add(name)
  }
  return names
}

type Rule = { selector: string; declarations: string; conditions: string[] }

/** Every style rule with the at-rules it stands in. The modules do not nest style rules. */
function rulesOf(css: string): Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  const conditions: string[] = []
  let start = 0
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (character === '{') {
      const prelude = source.slice(start, index).trim().replace(/\s+/g, ' ')
      if (prelude.startsWith('@')) {
        conditions.push(prelude)
      } else {
        const end = source.indexOf('}', index)
        rules.push({
          selector: prelude,
          declarations: source.slice(index + 1, end),
          conditions: [...conditions],
        })
        index = end
      }
      start = index + 1
    } else if (character === '}') {
      conditions.pop()
      start = index + 1
    }
  }
  return rules
}

const under = (rule: Rule, feature: string) =>
  rule.conditions.some((condition) => condition.startsWith('@media') && condition.includes(feature))

/** Every `styles.x` of the components that import the module. */
function referencesTo(module: string): Set<string> {
  const names = new Set<string>()
  for (const component of components) {
    const source = read(component)
    if (!source.includes(`import styles from './${module}'`)) continue
    for (const [, name = ''] of source.matchAll(/\bstyles\.(\w+)/g)) names.add(name)
  }
  return names
}

describe('landing CSS modules', () => {
  it('finds the modules', () => {
    expect(modules).toEqual(['landing.module.css', 'pricing.module.css', 'site-demo.module.css'])
  })

  describe.each(modules)('%s', (module) => {
    const classes = classesOf(read(module))
    const references = referencesTo(module)

    it('is used by a component', () => {
      expect(references.size).toBeGreaterThan(0)
    })

    it('defines every class the components ask for', () => {
      expect([...references].filter((name) => !classes.has(name))).toEqual([])
    })

    it('has no class without markup', () => {
      expect([...classes].filter((name) => !references.has(name))).toEqual([])
    })

    const rules = rulesOf(read(module))

    // After a tap a touch screen keeps the hover of the element until the next tap elsewhere.
    it('styles a hover only where the device can hover', () => {
      const hovers = rules.filter((rule) => rule.selector.includes(':hover'))
      expect(hovers.length).toBeGreaterThan(0)
      expect(
        hovers.filter((rule) => !under(rule, '(hover: hover)')).map((rule) => rule.selector),
      ).toEqual([])
    })

    it('keeps the states of the keyboard and of a press out of the hover query', () => {
      const gated = rules.filter(
        (rule) => under(rule, '(hover: hover)') && /:(focus-visible|active)/.test(rule.selector),
      )
      expect(gated.map((rule) => rule.selector)).toEqual([])
      expect(rules.some((rule) => rule.selector.includes(':active'))).toBe(true)
    })

    // The block of reduced motion takes away transitions and animations, not a transform: a
    // lift, a shift of an arrow, a press or the grip of the slider declared outside this query
    // would be a jump. The line of a navigation link is drawn with a scale and simply appears:
    // it is not a move.
    it('moves a hovered or pressed element only when motion is welcome', () => {
      const moves = rules.filter(
        (rule) =>
          (rule.selector.includes(':hover') &&
            /\btransform\s*:[^;]*translate/.test(rule.declarations)) ||
          /scale\((0\.98|1\.12)\)/.test(rule.declarations),
      )
      expect(moves.length).toBeGreaterThan(0)
      expect(
        moves
          .filter((rule) => !under(rule, '(prefers-reduced-motion: no-preference)'))
          .map((rule) => rule.selector),
      ).toEqual([])
    })

    // A time or a curve written in place is a sixteenth duration waiting to happen. The scale is
    // the tokens of the theme and the variables that the root rules of the modules name.
    it('takes every time and curve of a transition or an animation from a variable', () => {
      const literal =
        /(?<![\w-])\d*\.?\d+m?s\b|cubic-bezier\(|(?<![\w-])(ease|ease-in|ease-out|ease-in-out|linear)(?![\w-])/
      const offenders = rules.flatMap((rule) =>
        rule.declarations
          .split(';')
          .map((declaration) => declaration.trim().replace(/\s+/g, ' '))
          .filter((declaration) => /^(transition|animation)(-[a-z-]+)?\s*:/.test(declaration))
          .filter((declaration) => literal.test(declaration.replace(/^[a-z-]+\s*:/, '')))
          .map((declaration) => `${rule.selector} { ${declaration} }`),
      )
      expect(offenders).toEqual([])
    })

    // Layout is not animated. Besides `transform` and `opacity`: colours of a state, the clip of
    // an entrance, the offset of an outline that finds its place, the blur of a value that
    // existed before the scale, and what a panel or an answer needs to open by itself.
    it('animates only what the system of motion allows', () => {
      const allowed = new Set([
        'transform',
        'opacity',
        'background',
        'background-color',
        'color',
        'border-color',
        'box-shadow',
        'display',
        'block-size',
        'content-visibility',
      ])
      const transitioned = rules.flatMap((rule) =>
        [...rule.declarations.matchAll(/(?:^|;)\s*transition\s*:([^;]+)/g)].flatMap(
          ([, value = '']) =>
            value
              .split(/,(?![^(]*\))/)
              .map((part) => part.trim().split(/\s+/)[0] ?? '')
              .filter((property) => property !== 'none'),
        ),
      )
      expect(transitioned.length).toBeGreaterThan(0)
      expect(transitioned.filter((property) => !allowed.has(property))).toEqual([])

      const source = read(module).replace(/\/\*[\s\S]*?\*\//g, '')
      const keyframed = [
        ...source.matchAll(/@keyframes\s+[\w-]+\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g),
      ].flatMap(([, body = '']) =>
        [...body.matchAll(/([a-z-]+)\s*:/g)].map(([, property]) => property),
      )
      expect(keyframed.length).toBeGreaterThan(0)
      expect(
        [...new Set(keyframed)].filter(
          (property) =>
            !['transform', 'opacity', 'clip-path', 'outline-offset', 'filter'].includes(
              property ?? '',
            ),
        ),
      ).toEqual([])
    })
  })

  describe('reduced motion', () => {
    const blocks = modules.flatMap((module) =>
      rulesOf(read(module))
        .filter((rule) => under(rule, '(prefers-reduced-motion: reduce)'))
        .map((rule) => ({ module, ...rule })),
    )

    it('is switched off in one block, which covers the demo and the pricing too', () => {
      expect([...new Set(blocks.map((rule) => rule.module))]).toEqual(['landing.module.css'])
      const everything = blocks.find((rule) => rule.selector.startsWith('.page *'))
      expect(everything?.selector).toBe('.page *, .page *::before, .page *::after')
      expect(everything?.declarations).toMatch(/animation:\s*none\s*!important/)
      expect(everything?.declarations).toMatch(/transition:\s*none\s*!important/)
    })

    // `.page *` does not reach these parts. A browser drops a whole list of selectors that names
    // a pseudo-element it does not know, so each has a rule of its own.
    it.each(['::details-content', '::-webkit-slider-thumb', '::-moz-range-thumb'])(
      'reaches %s with a rule of its own',
      (part) => {
        const own = blocks.filter((rule) => rule.selector.includes(part))
        expect(own).toHaveLength(1)
        expect(own[0]?.selector).not.toContain(',')
        expect(own[0]?.declarations).toMatch(/transition:\s*none\s*!important/)
      },
    )

    it('leaves no part with a transition that the block does not reach', () => {
      const parts = modules.flatMap((module) =>
        rulesOf(read(module))
          .filter(
            (rule) =>
              /::(?!before|after)[\w-]+/.test(rule.selector) &&
              /(?:^|;)\s*(transition|animation)\s*:/.test(rule.declarations) &&
              !under(rule, '(prefers-reduced-motion: reduce)'),
          )
          .map((rule) => /::[\w-]+/.exec(rule.selector)?.[0]),
      )
      expect(parts.length).toBeGreaterThan(0)
      for (const part of parts) {
        expect(blocks.some((rule) => rule.selector.includes(part ?? '?'))).toBe(true)
      }
    })
  })

  describe('numbers of motion shared with the scripts', () => {
    const page = rulesOf(read('landing.module.css')).find(
      (rule) => rule.selector === '.page' && rule.conditions.length === 0,
    )
    const variable = (name: string) =>
      new RegExp(`${name}:\\s*([^;]+);`).exec(page?.declarations ?? '')?.[1]?.trim()

    it('are the same in motion.ts and on .page', () => {
      expect(variable('--motion-move')).toBe(`${MOVE_MS}ms`)
      expect(variable('--motion-rise')).toBe(`${RISE_PX}px`)
      // The curve of the reveal is the token of the theme on both sides.
      expect(variable('--ease')).toBe('var(--raditi-ease-out)')
    })

    it('leave the phases of the demo to the script alone', () => {
      const demo = read('site-demo.module.css')
      // The stage gets the length of its phase from site-demo.tsx; CSS only reads it.
      expect(demo).toContain('var(--demo-phase)')
      expect(demo).not.toMatch(/--demo-phase\s*:/)
      expect(read('site-demo.tsx')).toContain("'--demo-phase'")
    })
  })
})
