import { describe, expect, it } from 'vitest'

import { orderIdFromQuery } from './order-id'

const ORDER_ID = '018f0000-0000-7000-8000-0000000000aa'

describe('orderIdFromQuery', () => {
  it('takes the id of an order as it is', () => {
    expect(orderIdFromQuery(ORDER_ID)).toBe(ORDER_ID)
  })

  it.each([
    ['a missing parameter', undefined],
    ['an empty parameter', ''],
    ['a word', 'nope'],
    ['an id with something after it', `${ORDER_ID}/`],
    ['an id with a space', ` ${ORDER_ID}`],
    ['an id cut short', ORDER_ID.slice(0, -1)],
    ['a number', '42'],
    ['a parameter given twice', [ORDER_ID, ORDER_ID]],
    ['a parameter given twice with one id', [ORDER_ID]],
  ])('names no order for %s', (_what, value) => {
    expect(orderIdFromQuery(value)).toBeNull()
  })
})
