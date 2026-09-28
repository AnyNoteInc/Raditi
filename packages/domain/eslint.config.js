import { config } from '@repo/eslint-config/base'

// The core does no I/O: dependency-cruiser checks imports, this checks globals it cannot see.
const ioGlobals = ['process', 'Buffer', 'fetch', 'XMLHttpRequest', 'WebSocket', 'require']

export default [
  ...config,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...ioGlobals.map((name) => ({ name, message: 'The domain core does no I/O: use a port.' })),
      ],
    },
  },
]
