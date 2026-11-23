// The global security headers of apps/web/next.config.ts, then (later) one entry for /a.
const global = [{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }]
export default {
  output: 'standalone',
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/b', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] }, // EARLIER than the global one
      { source: '/((?!v/).*)', headers: global },
      { source: '/a', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] }, // later than the global one
    ]
  },
}
