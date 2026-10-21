// Ports and adapters (spec §6, CLAUDE.md «Как писать код»). Dependencies point inward:
//   apps (composition) → trpc (transport) → services → adapters → domain (core, ports)
// observability sits beside the layers: server-only helpers of the apps (health, metrics,
// bearer token, throttled error log) on domain and @prometheus-io/client; only apps import it.
// `$1` in `pathNot` back-references the package captured in `from.path`, so a package may
// import itself but not its peers.

const TOOLING = '^packages/(eslint-config|typescript-config)/'
const ADAPTERS =
  'db|storage|vault|git-providers|sandbox-providers|browser-providers|agent-drivers|llm-backends|site-adapters|site-connections|snapshots|yookassa|mail|telegram'
// A leaf: imports nothing of the repository. The apps import it, and so does a package whose
// tier rule names it (preview-gateway); the other tier rules do not allow it.
const LEAVES = 'ip-address'
const SERVICES = 'auth|notifications|billing|local-turns|turn-keys|site-content|preview-gateway'
// The frame and runtime of the apps (process start and stop, Nest wiring, health):
// app-side code that lives in a package, so it may use observability, which no library package may.
const RUNTIME = 'app-bootstrap|service-runtime|runner-engine'
// Every package must belong to a layer; an unclassified one would bypass all rules.
const KNOWN = `^packages/(domain|observability|${ADAPTERS}|${SERVICES}|${RUNTIME}|${LEAVES}|trpc|ui|eslint-config|typescript-config)/`
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
      name: 'observability-imports-only-domain',
      comment:
        'packages/observability (health, metrics, error log of the server apps) builds on domain, Node built-ins and the Prometheus client only.',
      severity: 'error',
      from: { path: '^packages/observability/' },
      to: {
        dependencyTypesNot: ['core'],
        pathNot: [
          '^packages/(domain|observability)/',
          TOOLING,
          ...npm('@prometheus-io/client|vitest'),
        ],
      },
    },
    {
      name: 'observability-only-in-apps',
      comment:
        'Server helpers for the apps: no library package imports packages/observability, except the runtime shared by the role apps.',
      severity: 'error',
      from: {
        path: '^packages/([^/]+)/',
        pathNot: '^packages/(observability|service-runtime|runner-engine)/',
      },
      to: { path: '^packages/observability/' },
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
      name: 'billing-tier',
      comment:
        'billing composes db, the payment shop and notifications; never auth, trpc, ui or agent infrastructure.',
      severity: 'error',
      from: { path: '^packages/billing/' },
      to: {
        path: '^packages/',
        pathNot: ['^packages/(domain|db|yookassa|notifications|billing)/', TOOLING],
      },
    },
    {
      name: 'local-turns-tier',
      comment:
        'local-turns composes the snapshots and nothing else: a runner VM holds no platform credentials.',
      severity: 'error',
      from: { path: '^packages/local-turns/' },
      to: { path: '^packages/', pathNot: ['^packages/(domain|snapshots|local-turns)/', TOOLING] },
    },
    {
      name: 'turn-keys-tier',
      comment:
        'turn-keys composes db and the backend registry; never the sandbox, trpc, ui or other services.',
      severity: 'error',
      from: { path: '^packages/turn-keys/' },
      to: {
        path: '^packages/',
        pathNot: ['^packages/(domain|db|llm-backends|turn-keys)/', TOOLING],
      },
    },
    {
      name: 'site-content-tier',
      comment:
        'site-content composes db, the snapshots and the turn-key formats; never trpc, ui or agent infrastructure.',
      severity: 'error',
      from: { path: '^packages/site-content/' },
      to: {
        path: '^packages/',
        pathNot: ['^packages/(domain|db|snapshots|turn-keys|site-content)/', TOOLING],
      },
    },
    {
      name: 'ip-address-is-a-leaf',
      comment:
        'ip-address parses and classifies addresses with node:net alone: it imports no package of the repository.',
      severity: 'error',
      from: { path: '^packages/ip-address/' },
      to: { path: '^packages/', pathNot: ['^packages/ip-address/', TOOLING] },
    },
    {
      name: 'app-bootstrap-tier',
      comment:
        'app-bootstrap is the frame of every app process (start, stop, logger, .env): domain only, so the runner can take it without a database or Redis.',
      severity: 'error',
      from: { path: '^packages/app-bootstrap/' },
      to: { path: '^packages/', pathNot: ['^packages/(domain|app-bootstrap)/', TOOLING] },
    },
    {
      name: 'service-runtime-tier',
      comment:
        'service-runtime wires Prisma and health for the apps with a database: domain, db and observability only (the network guard of its tests is test support).',
      severity: 'error',
      from: { path: '^packages/service-runtime/' },
      to: {
        path: '^packages/',
        pathNot: [
          '^packages/(domain|db|observability|service-runtime)/',
          '^packages/app-bootstrap/src/testing/',
          TOOLING,
        ],
      },
    },
    {
      name: 'preview-gateway-tier',
      comment:
        'preview-gateway serves previews from the database: domain, db and the address helpers only (the runtime is test support).',
      severity: 'error',
      from: { path: '^packages/preview-gateway/' },
      to: {
        path: '^packages/',
        pathNot: [
          '^packages/(domain|db|ip-address|preview-gateway)/',
          '^packages/app-bootstrap/src/testing/',
          TOOLING,
        ],
      },
    },
    {
      name: 'package-testing-only-in-tests',
      comment:
        'The testing part of a package (sample ids, the network guard, scripted fakes, the test config of the runner) is test support: only tests, the testing modules of the apps and the stand scripts import it.',
      severity: 'error',
      from: {
        path: '^(apps|packages)/',
        pathNot: [
          '\\.test\\.tsx?$',
          '^apps/e2e/',
          '^apps/[^/]+/src/testing/',
          '^apps/[^/]+/scripts/',
          '^packages/[^/]+/src/testing(/|\\.ts$)',
        ],
      },
      to: {
        path: [
          '^packages/(turn-keys|snapshots)/src/testing\\.ts$',
          '^packages/(app-bootstrap|service-runtime|runner-engine)/src/testing/',
        ],
      },
    },
    {
      name: 'web-no-role-runtime',
      comment:
        'The web app and the libraries it composes never reach the role runtime or the code the role apps share (plan 55).',
      severity: 'error',
      from: { path: '^(apps/web|packages/(trpc|ui|auth|billing|notifications))/' },
      to: {
        path: '^packages/(app-bootstrap|service-runtime|turn-keys|local-turns|snapshots|site-content)/',
        reachable: true,
      },
    },
    {
      name: 'runner-engine-tier',
      comment:
        'runner-engine drives a sandbox VM: the sandbox and agent adapters, the local-turn code and the snapshots — no database, Redis, Vault or S3 (plan 55).',
      severity: 'error',
      from: { path: '^packages/runner-engine/' },
      to: {
        path: '^packages/',
        pathNot: [
          '^packages/(domain|agent-drivers|sandbox-providers|local-turns|snapshots|observability|runner-engine)/',
          '^packages/app-bootstrap/src/testing/',
          TOOLING,
        ],
      },
    },
    {
      name: 'runner-minimal-packages',
      comment:
        'The runner app holds no platform credentials: it composes the runner engine, the sandbox settings and the frame of a process (app-bootstrap), never the runtime of the apps with a database, not even transitively (rule 5, spec §19).',
      severity: 'error',
      from: { path: '^(apps/runner|packages/(runner-engine|snapshots|local-turns))/' },
      to: { path: '^packages/(service-runtime|db)/', reachable: true },
    },
    {
      name: 'billing-testing-only-in-tests',
      comment:
        '@repo/billing/testing (fixtures that write rows directly, the scripted shop) is test support: only test files import it, in billing and in every other package. apps/e2e is test code as a whole: its fixtures write the model calls a charged task needs.',
      severity: 'error',
      from: {
        path: '^(apps|packages)/',
        pathNot: ['\\.test\\.tsx?$', '^apps/e2e/', '^packages/billing/src/testing\\.ts$'],
      },
      to: { path: '^packages/billing/src/testing\\.ts$' },
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
      name: 'core-no-trpc-ui',
      comment: 'The core app reaches business logic via domain, never via trpc or ui.',
      severity: 'error',
      from: { path: '^apps/core/' },
      to: { path: '^packages/(trpc|ui)/' },
    },
    {
      name: 'llm-no-trpc-ui',
      comment:
        'The llm, mcp, runner and preview apps reach business logic via domain, never via trpc or ui.',
      severity: 'error',
      from: { path: '^apps/(llm|mcp|runner|preview)/' },
      to: { path: '^packages/(trpc|ui)/' },
    },
    {
      name: 'mcp-minimal-packages',
      comment:
        'The mcp app is what the sandboxes reach (rule 5): it composes the database, Vault, the content stores, the browser and the shared content code — no git, sandbox, agent, payments, mail or provider code, not even transitively.',
      severity: 'error',
      from: { path: '^apps/mcp/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^packages/(git-providers|sandbox-providers|agent-drivers|llm-backends|site-connections|yookassa|mail|telegram|auth|notifications|billing|local-turns|trpc|ui)/',
        reachable: true,
      },
    },
    {
      name: 'llm-minimal-packages',
      comment:
        'The llm app is the one process that holds a provider key (rule 1, 2): it composes the database, Vault, the backend registry, the turn keys and the runtime — no storage, git, sandbox, browser, payments, mail or content code, not even transitively.',
      severity: 'error',
      from: { path: '^apps/llm/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^packages/(storage|git-providers|sandbox-providers|browser-providers|agent-drivers|site-adapters|site-connections|yookassa|mail|telegram|auth|notifications|billing|snapshots|local-turns|site-content)/',
        reachable: true,
      },
    },
    {
      name: 'preview-minimal-packages',
      comment:
        'The preview app serves the iframe of the cabinet from the database: no storage, Vault, git, sandbox, agent, payments, mail or content code, not even transitively.',
      severity: 'error',
      from: { path: '^apps/preview/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^packages/(storage|vault|git-providers|sandbox-providers|browser-providers|agent-drivers|llm-backends|site-adapters|site-connections|yookassa|mail|telegram|auth|notifications|billing|snapshots|local-turns|turn-keys|site-content|runner-engine|trpc|ui)/',
        reachable: true,
      },
    },
    {
      name: 'core-product-no-testing',
      comment:
        'src/testing of an app holds the fakes and the sample ids of tests and stands: no product module imports it.',
      severity: 'error',
      from: {
        path: '^apps/(core|llm|mcp|runner|preview)/src/',
        pathNot: ['\\.test\\.ts$', '^apps/[^/]+/src/testing/'],
      },
      to: { path: '^apps/(core|llm|mcp|runner|preview)/src/testing/' },
    },
    {
      name: 'runner-no-platform-access',
      comment:
        'The runner role and the local executor it drives never reach PostgreSQL, Redis, Vault, S3, the payment shop or core’s runner API, not even transitively: a sandbox VM holds no platform credentials (spec §8, §19).',
      severity: 'error',
      from: {
        path: '^(apps/runner/|packages/(snapshots|local-turns|runner-engine)/)',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        path: [
          '^packages/(db|vault|storage|llm-backends|yookassa|billing)/',
          '^apps/core/src/runner-api/',
          ...npm('ioredis|bullmq|@prisma/[^/]+|@aws-sdk/[^/]+'),
        ],
        reachable: true,
      },
    },
    {
      name: 'deploy-step-no-platform-access',
      comment:
        'The deploy-step command runs inside the deploy job of a site (docs/plan/53-chat-preview-release.md, Р30): it has no database, Redis or S3, not even transitively. Everything it needs comes from the release API.',
      severity: 'error',
      from: { path: '^apps/core/src/deploy-step/', pathNot: '\\.test\\.ts$' },
      to: {
        path: [
          '^packages/(db|storage|billing)/',
          ...npm('ioredis|bullmq|@prisma/[^/]+|@aws-sdk/[^/]+|pg'),
        ],
        reachable: true,
      },
    },
    {
      name: 'web-no-sandbox',
      comment:
        'Only the core and llm apps run agents, sandboxes, browsers and subscription backends.',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: {
        path: '^packages/(sandbox-providers|browser-providers|agent-drivers|llm-backends)/',
        reachable: true,
      },
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
