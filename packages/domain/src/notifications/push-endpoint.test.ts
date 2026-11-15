import { describe, expect, it } from 'vitest'

import { isPushEndpoint } from './push-endpoint.ts'

describe('the endpoint of a Web Push subscription (docs/plan/75, ВВ8)', () => {
  it('is a push service of a browser', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      'https://web.push.apple.com/QGx',
    ])
      expect(isPushEndpoint(endpoint), endpoint).toBe(true)
  })

  it('is never an address of the platform, a private one, another site or a tricky form', () => {
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/x',
      'https://user@fcm.googleapis.com/x',
      'https://10.10.0.10:8200/v1/sys',
      'https://localhost/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilfcm.googleapis.com.example/x',
      'https://raditi.ru/api',
      'not a url',
    ])
      expect(isPushEndpoint(endpoint), endpoint).toBe(false)
  })
})
