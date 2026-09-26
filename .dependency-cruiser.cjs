// Ports and adapters (spec §6, CLAUDE.md «Как писать код»). Dependencies point inward:
//   apps (composition) → trpc (transport) → services → adapters → domain (core, ports)
// `$1` in `pathNot` back-references the package captured in `from.path`, so a package may
// import itself but not its peers.

const TOOLING = '^packages/(eslint-config|typescript-config)/'
const ADAPTERS =
  'db|storage|vault|git-providers|sandbox-providers|agent-drivers|site-adapters|yookassa|mail|telegram'
const SERVICES = 'auth|notifications'
// Every package must belong to a layer; an unclassified one would bypass all rules.
const KNOWN = `^packages/(domain|${ADAPTERS}|${SERVICES}|trpc|ui|eslint-config|typescript-config)/`
const npm = (names) => [`node_modules/\\.pnpm/(${names})@`, `node_modules/(${names})/`]
const CORE_DEPS = 'zod|decimal\\.js'

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'No cyclic dependencies between modules.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolvable-repo-import',
      comment: 'An @repo/* import depcruise cannot resolve would silently bypass every rule below.',
      severity: 'error',
      from: { path: '^(packages|apps)/' },
      to: { couldNotResolve: true, path: '^@repo/' },
    },
    {
      name: 'no-unclassified-package',
      comment: 'Imports only packages that belong to a layer (add new packages to this config).',
      severity: 'error',
      from: { path: '^(apps|packages)/' },
      to: { path: '^packages/', pathNot: KNOWN },
    },
    {
      name: 'unclassified-package-imports-nothing',
      comment: 'A package outside the layer lists must not import other packages either.',
      severity: 'error',
      from: { path: '^packages/([^/]+)/', pathNot: KNOWN },
      to: { path: '^packages/', pathNot: '^packages/$1/' },
    },
    {
      name: 'domain-is-the-core',
      comment: 'packages/domain (ports, core logic) depends on no other @repo package.',
      severity: 'error',
      from: { path: '^packages/domain/' },
      to: { path: '^packages/', pathNot: ['^packages/domain/', TOOLING] },
    },
    {
      name: 'domain-no-infrastructure',
      comment:
        'The core stays free of I/O: no Node built-ins, no npm packages except zod and decimal.js.',
      severity: 'error',
      from: { path: '^packages/domain/src/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypesNot: ['local'], pathNot: npm(CORE_DEPS) },
    },
    {
      name: 'domain-tests-no-infrastructure',
      comment: 'Domain tests may add vitest, nothing else.',
      severity: 'error',
      from: { path: '^packages/domain/src/.*\\.test\\.ts$' },
      to: { dependencyTypesNot: ['local'], pathNot: npm(`${CORE_DEPS}|vitest`) },
    },
    {
      name: 'adapters-depend-on-domain-only',
      comment: `Adapters (${ADAPTERS}) implement domain ports and never import each other.`,
      severity: 'error',
      from: { path: `^packages/(${ADAPTERS})/` },
      to: { path: '^packages/', pathNot: ['^packages/domain/', '^packages/$1/', TOOLING] },
    },
    {
      name: 'notifications-tier',
      comment: 'notifications composes only the delivery adapters.',
      severity: 'error',
      from: { path: '^packages/notifications/' },
      to: {
        path: '^packages/',
        pathNot: ['^packages/(domain|db|mail|telegram|notifications)/', TOOLING],
      },
    },
    {
      name: 'auth-tier',
      comment: 'auth composes db, mail and notifications; never trpc, ui or agent infrastructure.',
      severity: 'error',
      from: { path: '^packages/auth/' },
      to: {
        path: '^packages/',
        pathNot: ['^packages/(domain|db|mail|notifications|auth)/', TOOLING],
      },
    },
    {
      name: 'trpc-no-ui',
      comment: 'Transport never imports UI.',
      severity: 'error',
      from: { path: '^packages/trpc/' },
      to: { path: '^packages/ui/' },
    },
    {
      name: 'ui-is-pure',
      comment: 'packages/ui imports no other @repo package: data comes in as props.',
      severity: 'error',
      from: { path: '^packages/ui/' },
      to: { path: '^packages/', pathNot: ['^packages/ui/', TOOLING] },
    },
    {
      name: 'packages-no-import-apps',
      comment: 'Library packages never import an app.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'apps-are-isolated',
      comment: 'Apps talk over the network (HTTP, queues), never by importing each other.',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: ['^apps/$1/'] },
    },
    {
      name: 'orchestrator-no-trpc-ui',
      comment: 'The orchestrator reaches business logic via domain, never via trpc or ui.',
      severity: 'error',
      from: { path: '^apps/orchestrator/' },
      to: { path: '^packages/(trpc|ui)/' },
    },
    {
      name: 'web-no-sandbox',
      comment: 'Only the orchestrator runs agents and sandboxes — not even transitively from web.',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^packages/(sandbox-providers|agent-drivers)/', reachable: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Anchored to our own apps and packages, so dist/ inside node_modules stays visible.
    exclude: {
      path: '^(apps|packages)/[^/]+/(\\.next|dist|coverage|\\.turbo|\\.vitest|src/generated)/',
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.json'],
    },
  },
}
