import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { Money } from '../money.ts'
import {
  availableEdits,
  chooseHoldAccount,
  editAccountKinds,
  editAccountSnapshot,
  editAccountSnapshotSchema,
  editAccountsSchema,
  editAccountUnits,
  emptyEditAccount,
  expiringTariffEdits,
  type EditAccounts,
  type EditAccountSnapshot,
  type EditAmountValue,
} from './edits.ts'

const account = (balance: number, held = 0): EditAccountSnapshot => ({ balance, held })
const accounts = (tariff: EditAccountSnapshot, pack: EditAccountSnapshot): EditAccounts => ({
  tariff,
  pack,
})
const badRequest = expect.objectContaining({ name: 'DomainError', code: 'BAD_REQUEST' })

describe('edit accounts', () => {
  it('maps the tariff and the pack to their database units', () => {
    expect(editAccountKinds).toEqual(['tariff', 'pack'])
    expect(editAccountUnits).toEqual({ tariff: 'edit', pack: 'edit_pack' })
    expect(Object.isFrozen(editAccountUnits)).toBe(true)
  })

  it('offers an empty account for a row that does not exist yet', () => {
    expect(emptyEditAccount).toEqual({ balance: 0, held: 0 })
    expect(Object.isFrozen(emptyEditAccount)).toBe(true)
    expect(availableEdits(accounts(emptyEditAccount, emptyEditAccount)).total).toBe(0)
  })

  it('keeps the empty account read-only for the compiler too', () => {
    expect(() => {
      // @ts-expect-error a hold is counted on a copy: the shared empty account is frozen
      emptyEditAccount.held += 1
    }).toThrow(TypeError)
    expect(emptyEditAccount).toEqual({ balance: 0, held: 0 })
    const copy: EditAccountSnapshot = { ...emptyEditAccount }
    copy.balance += 1
    expect(chooseHoldAccount(accounts(copy, emptyEditAccount))).toBe('tariff')
  })
})

describe('editAccountSnapshot', () => {
  it.each<[string, EditAmountValue, EditAmountValue, EditAccountSnapshot]>([
    ['decimal strings of the column', '30.00', '2.00', account(30, 2)],
    ['whole strings', '250', '0', account(250, 0)],
    ['numbers', 80, 80, account(80, 80)],
    ['Decimal objects', new Decimal('30.00'), new Decimal('1'), account(30, 1)],
    ['Decimal objects of another constructor', new Money('10'), new Money('0.00'), account(10)],
    [
      'any object that prints a decimal',
      { toFixed: () => '7.00' },
      { toFixed: () => '7' },
      account(7, 7),
    ],
    ['the largest Decimal(14,2) whole value', '999999999999.00', '0.00', account(999_999_999_999)],
    ['a zero with a sign', '-0.00', '0.00', account(0, 0)],
  ])('reads %s', (_name, balance, held, expected) => {
    expect(editAccountSnapshot({ balance, held })).toEqual(expected)
  })

  it('returns plain non-negative zeros', () => {
    const snapshot = editAccountSnapshot({ balance: '-0.00', held: -0 })
    expect(Object.is(snapshot.balance, 0)).toBe(true)
    expect(Object.is(snapshot.held, 0)).toBe(true)
  })

  it.each<[string, unknown, unknown]>([
    ['a fractional balance (a RUB wallet)', '1500.50', '0.00'],
    ['a fractional hold', '30.00', '0.01'],
    ['a fractional number', 0.5, 0],
    ['a negative balance', '-1.00', '0.00'],
    ['a negative hold', '30.00', '-1.00'],
    ['held above balance', '1.00', '2.00'],
    ['a thirteenth integer digit', '1000000000000.00', '0.00'],
    ['NaN', Number.NaN, 0],
    ['infinity', Number.POSITIVE_INFINITY, 0],
    ['text', 'thirty', '0'],
    ['an empty string', '', '0'],
    ['a comma', '30,00', '0'],
    // notations decimal.js reads and the database never prints
    ['a hexadecimal string', '0x1F', '0'],
    ['a binary string', '0b11', '0'],
    ['an octal string', '0o17', '0'],
    ['an exponent', '1e3', '0'],
    ['a digit separator', '3_0', '0'],
    ['a leading plus', '+30', '0'],
    ['a point without a fraction', '30.', '0'],
    ['a point without an integer part', '.0', '0'],
    ['a space around the digits', ' 30', '0'],
    ['a line break after the digits', '30\n', '0'],
    ['the word Infinity', 'Infinity', '0'],
    ['a BigInt', 30n, 0],
    ['a hexadecimal hold', '30', '0x1'],
    ['an object that prints an exponent', { toFixed: () => '3e1' }, 0],
    ['null', null, 0],
    ['undefined', undefined, 0],
    ['a boolean', true, 0],
    ['an object that prints text', { toFixed: () => 'many' }, 0],
    ['an object without toFixed', {}, 0],
  ])('refuses %s', (_name, balance, held) => {
    const row = { balance, held } as { balance: EditAmountValue; held: EditAmountValue }
    expect(() => editAccountSnapshot(row)).toThrow(badRequest)
  })
})

describe('availableEdits', () => {
  it.each([
    ['both accounts empty', account(0), account(0), { tariff: 0, pack: 0, total: 0 }],
    ['a fresh tariff', account(30), account(0), { tariff: 30, pack: 0, total: 30 }],
    ['a pack without a tariff', account(0), account(10), { tariff: 0, pack: 10, total: 10 }],
    ['both accounts', account(30), account(10), { tariff: 30, pack: 10, total: 40 }],
    ['holds on the tariff', account(30, 2), account(10), { tariff: 28, pack: 10, total: 38 }],
    ['holds on both', account(30, 2), account(10, 3), { tariff: 28, pack: 7, total: 35 }],
    ['a held-out tariff', account(5, 5), account(10), { tariff: 0, pack: 10, total: 10 }],
    ['a held-out pack', account(5), account(10, 10), { tariff: 5, pack: 0, total: 5 }],
    ['both held out', account(5, 5), account(10, 10), { tariff: 0, pack: 0, total: 0 }],
    [
      'the largest accounts',
      account(999_999_999_999),
      account(999_999_999_999),
      {
        tariff: 999_999_999_999,
        pack: 999_999_999_999,
        total: 1_999_999_999_998,
      },
    ],
  ])('%s', (_name, tariff, pack, expected) => {
    expect(availableEdits(accounts(tariff, pack))).toEqual(expected)
  })

  it('does not change its input', () => {
    const input = accounts(account(30, 2), account(10, 3))
    availableEdits(input)
    expect(input).toEqual(accounts(account(30, 2), account(10, 3)))
  })
})

describe('chooseHoldAccount', () => {
  it.each([
    ['empty accounts', account(0), account(0), null],
    ['only tariff edits', account(30), account(0), 'tariff'],
    ['only pack edits', account(0), account(10), 'pack'],
    ['both: the tariff goes first', account(30), account(10), 'tariff'],
    ['the last tariff edit', account(30, 29), account(10), 'tariff'],
    ['a held-out tariff and a pack', account(30, 30), account(10), 'pack'],
    ['a held-out tariff and the last pack edit', account(30, 30), account(10, 9), 'pack'],
    ['a held-out tariff and no pack', account(30, 30), account(0), null],
    ['no tariff and a held-out pack', account(0), account(10, 10), null],
    ['both held out', account(30, 30), account(10, 10), null],
    ['a tariff with one edit and a held-out pack', account(1), account(10, 10), 'tariff'],
  ] as const)('%s → %s', (_name, tariff, pack, expected) => {
    expect(chooseHoldAccount(accounts(tariff, pack))).toBe(expected)
  })

  it('spends the tariff down to its last edit before it touches the pack', () => {
    const tariff = account(3)
    const pack = account(2)
    const order: (string | null)[] = []
    for (let hold = 0; hold < 6; hold++) {
      const kind = chooseHoldAccount(accounts(tariff, pack))
      order.push(kind)
      if (kind === 'tariff') tariff.held += 1
      if (kind === 'pack') pack.held += 1
    }
    expect(order).toEqual(['tariff', 'tariff', 'tariff', 'pack', 'pack', null])
    expect(availableEdits(accounts(tariff, pack)).total).toBe(0)
  })

  it('names an account whose unit a hold can copy', () => {
    const kind = chooseHoldAccount(accounts(account(0), account(1)))
    expect(kind && editAccountUnits[kind]).toBe('edit_pack')
  })
})

describe('expiringTariffEdits', () => {
  it.each([
    ['an untouched quota', account(30), 30],
    ['a partly spent quota', account(12), 12],
    ['edits under a hold stay', account(12, 2), 10],
    ['everything left is held', account(3, 3), 0],
    ['an empty account', account(0), 0],
  ])('%s', (_name, tariff, expected) => {
    expect(expiringTariffEdits(tariff)).toBe(expected)
  })

  it('leaves exactly the held edits on the account', () => {
    for (const tariff of [account(30, 2), account(3, 3), account(80), account(0)]) {
      const left = tariff.balance - expiringTariffEdits(tariff)
      expect(left).toBe(tariff.held)
      // The remaining row still satisfies held <= balance.
      expect(editAccountSnapshotSchema.safeParse(account(left, tariff.held)).success).toBe(true)
    }
  })

  it('equals what availableEdits reports for the tariff and never counts the pack', () => {
    const tariff = account(30, 4)
    const both = accounts(tariff, account(10, 1))
    expect(expiringTariffEdits(tariff)).toBe(availableEdits(both).tariff)
  })
})

describe('edit account validation', () => {
  const invalid: readonly (readonly [string, unknown])[] = [
    ['a fractional balance', { balance: 1.5, held: 0 }],
    ['a fractional hold', { balance: 2, held: 0.5 }],
    ['a negative balance', { balance: -1, held: 0 }],
    ['a negative hold', { balance: 1, held: -1 }],
    ['held above balance', { balance: 1, held: 2 }],
    ['NaN', { balance: Number.NaN, held: 0 }],
    ['infinity', { balance: Number.POSITIVE_INFINITY, held: 0 }],
    ['more than Decimal(14,2) holds', { balance: 1_000_000_000_000, held: 0 }],
    ['a decimal string', { balance: '30.00', held: '0.00' }],
    ['a Decimal object', { balance: new Money(30), held: new Money(0) }],
    ['a missing field', { balance: 30 }],
    ['an unknown field', { balance: 30, held: 0, unit: 'rub' }],
    ['null', null],
  ]

  it.each(invalid)('refuses %s as an account', (_name, value) => {
    const bad = value as EditAccountSnapshot
    expect(editAccountSnapshotSchema.safeParse(bad).success).toBe(false)
    expect(() => expiringTariffEdits(bad)).toThrow(badRequest)
    expect(() => availableEdits(accounts(bad, account(1)))).toThrow(badRequest)
    expect(() => availableEdits(accounts(account(1), bad))).toThrow(badRequest)
    expect(() => chooseHoldAccount(accounts(bad, account(1)))).toThrow(badRequest)
    expect(() => chooseHoldAccount(accounts(account(1), bad))).toThrow(badRequest)
  })

  it('refuses a pair without one of the accounts or with a third one', () => {
    const onlyTariff = { tariff: account(1) } as EditAccounts
    const withWallet = { ...accounts(account(1), account(1)), rub: account(1) } as EditAccounts
    for (const bad of [onlyTariff, withWallet, null as unknown as EditAccounts]) {
      expect(editAccountsSchema.safeParse(bad).success).toBe(false)
      expect(() => availableEdits(bad)).toThrow(badRequest)
      expect(() => chooseHoldAccount(bad)).toThrow(badRequest)
    }
  })

  it('accepts the boundaries: zero, held equal to balance, the largest value', () => {
    for (const ok of [account(0), account(7, 7), account(999_999_999_999, 999_999_999_999)]) {
      expect(editAccountSnapshotSchema.parse(ok)).toEqual(ok)
    }
  })
})
