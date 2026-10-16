import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    // With a database the files run one after another: the checkout tests put tariffs of their
    // own on sale and remove them, which a listing of the tariffs in another file must not see
    // change between its two reads.
    fileParallelism: !process.env.DATABASE_URL,
  },
})
