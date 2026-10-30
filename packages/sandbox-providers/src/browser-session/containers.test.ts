import type { AppEnv } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { browserSessionDefaultLimits } from './config.ts'
import {
  browserContainer,
  egressContainer,
  firewallContainer,
  forwarderContainer,
  type BrowserSessionPlace,
} from './containers.ts'

const image = (name: string) => `registry.local:3300/raditi/${name}@sha256:${'0'.repeat(63)}1`
const place: BrowserSessionPlace = {
  identity: {
    sessionId: '0196abcd-0000-7000-8000-0000000000a1',
    taskId: '0196abcd-0000-7000-8000-0000000000a2',
    siteId: '0196abcd-0000-7000-8000-0000000000a3',
  },
  deadline: 1_900_000_000_000,
  network: { id: 'n'.repeat(64), subnet: '172.30.0.0/24' },
}
const egressOf = (localRoutes: Record<string, string> = {}, appEnv: AppEnv = 'production') =>
  egressContainer({
    place,
    appEnv,
    image: image('egress'),
    limits: browserSessionDefaultLimits.service,
    allowedHosts: ['news.example.ru:443', 'www.news.example.ru:443'],
    localRoutes,
    refusedSubnets: ['84.201.128.0/18'],
    maxTunnels: 48,
  })

describe('browser session containers', () => {
  it('runs every container without privilege, writable root or a restart', () => {
    for (const options of [
      egressOf(),
      forwarderContainer({
        place,
        image: image('tools'),
        limits: browserSessionDefaultLimits.service,
      }),
      browserContainer({
        place,
        image: image('browser'),
        runtime: 'runsc',
        limits: browserSessionDefaultLimits.browser,
      }),
    ])
      expect(options.HostConfig).toMatchObject({
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        RestartPolicy: { Name: 'no' },
      })
  })

  it('gives the egress proxy the browser as its only client, the session’s hosts and the internet', () => {
    const egress = egressOf()
    expect(egress.name).toBe(`raditi-browser-${place.identity.sessionId}-egress`)
    expect(egress.User).toBe('10001:10001')
    expect(egress.Env).toEqual([
      // The proxy refuses local routes in production on its own (client-egress.mjs).
      'APP_ENV=production',
      'LISTEN_HOST=172.30.0.2',
      'LISTEN_PORT=3128',
      'CLIENT_IPV4=172.30.0.3',
      'ALLOWED_HOSTS=["news.example.ru:443","www.news.example.ru:443"]',
      // Chromium's ECH with the listed host as its outer name passes (client-egress.mjs).
      'ECH_OUTER_NAME=1',
      // Another site a page of the site goes on to: public names only (plan 60, Ч3).
      'ALLOW_PUBLIC=1',
      'PUBLIC_TLS_ONLY=1',
      'MAX_TUNNELS=48',
      'REFUSED_SUBNETS=84.201.128.0/18',
    ])
    expect(egress.HostConfig).toMatchObject({
      NetworkMode: 'bridge',
      NanoCpus: 250_000_000,
      Memory: 128 * 1024 * 1024,
      Sysctls: { 'net.ipv4.ip_forward': '0' },
    })
    expect(egress.HostConfig?.ExtraHosts).toBeUndefined()
    expect(egress.Labels).toMatchObject({
      'io.raditi.browser.role': 'egress',
      'io.raditi.browser.deadline': '1900000000000',
    })
  })

  it('names local sites only with their guard, and the host as host-gateway names it', () => {
    const egress = egressOf({ 'wp.localhost:8080': 'host.docker.internal:18080' }, 'test')
    expect(egress.Env).toEqual(
      expect.arrayContaining([
        'APP_ENV=test',
        'LOCAL_HTTP_ROUTES={"wp.localhost:8080":"host.docker.internal:18080"}',
        'RADITI_EGRESS_LOCAL_ROUTES=1',
      ]),
    )
    expect(egress.HostConfig?.ExtraHosts).toEqual(['host.docker.internal:host-gateway'])
    // Another list of hosts or routes is another container.
    expect(egress.Labels?.['io.raditi.browser.config']).not.toBe(
      egressOf().Labels?.['io.raditi.browser.config'],
    )
  })

  it('publishes the control port on the host loopback only, through the forwarder', () => {
    const forwarder = forwarderContainer({
      place,
      image: image('tools'),
      limits: browserSessionDefaultLimits.service,
    })
    expect(forwarder.Entrypoint).toEqual([
      '/usr/bin/tini',
      '--',
      '/usr/local/bin/node',
      '/usr/local/lib/raditi/forward.mjs',
    ])
    expect(forwarder.Cmd).toEqual(['0.0.0.0:9333=172.30.0.3:9333'])
    expect(forwarder.HostConfig).toMatchObject({
      NetworkMode: 'bridge',
      PortBindings: { '9333/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
    })
  })

  it('keeps Chromium on the session’s network, its traffic to the egress proxy', () => {
    const browser = browserContainer({
      place,
      image: image('browser'),
      runtime: 'runsc',
      limits: browserSessionDefaultLimits.browser,
    })
    expect(browser.Cmd).toEqual([
      '--host=172.30.0.3',
      '--port=9333',
      '--proxy=http://172.30.0.2:3128',
    ])
    expect(browser.HostConfig).toMatchObject({
      Runtime: 'runsc',
      NetworkMode: place.network.id,
      ShmSize: 256 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      Memory: 1536 * 1024 * 1024,
      PidsLimit: 512,
    })
    expect(browser.HostConfig?.PortBindings).toBeUndefined()
    expect(browser.HostConfig?.Tmpfs?.['/run/raditi/browser']).toContain('noexec')
    expect(browser.NetworkingConfig?.EndpointsConfig).toEqual({
      [place.network.id]: { IPAMConfig: { IPv4Address: '172.30.0.3' } },
    })
  })

  it('runs the host firewall helper under the session’s labels', () => {
    const helper = firewallContainer({
      identity: place.identity,
      image: image('guard'),
      args: ['install', 'rpb0123456789ab'],
      suffix: 'install-1',
    })
    expect(helper.name).toBe(`raditi-browser-${place.identity.sessionId}-firewall-install-1`)
    expect(helper.Cmd).toEqual(['install', 'rpb0123456789ab'])
    expect(helper.HostConfig).toMatchObject({
      Runtime: 'runc',
      NetworkMode: 'host',
      CapAdd: ['NET_ADMIN'],
    })
    expect(helper.Labels?.['io.raditi.browser.role']).toBe('firewall')
  })
})
