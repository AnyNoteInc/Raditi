/* global console, process, setTimeout, clearTimeout, URL */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 10.250.0.0/24 stands for the sandbox VM subnet; the /32 exercises nft's other listing form.
const settings =
  'COMPOSE_PROFILES=llm\nAPP_PRIVATE_IP=10.10.0.10\nVAULT_PRIVATE_IP=10.10.0.20\nEGRESS_PROXY_IP=93.184.216.34\nLLM_GATEWAY_CLIENTS=10.250.0.0/24,10.10.2.7/32,172.29.84.1/32'
// What dockerd 29 installs for `APP_PRIVATE_IP:8084:8084` of a container whose gateway network
// is llm-out, and for the masquerading bridges of core and web (read from a real daemon).
const published = `table ip published {
  chain prerouting {
    type nat hook prerouting priority dstnat;
    ip daddr 10.10.0.10 tcp dport 8084 dnat to 172.29.84.2:8084
  }
  chain postrouting {
    type nat hook postrouting priority srcnat;
    ip saddr 172.29.87.0/24 oifname != "rd-core" masquerade
    ip saddr 172.29.88.0/24 oifname != "rd-web" masquerade
  }
}
`
const serverPython =
  'import socket,threading,time\nfor family,address,port in [(socket.AF_INET,"0.0.0.0",443),(socket.AF_INET,"0.0.0.0",8200),(socket.AF_INET,"0.0.0.0",5432),(socket.AF_INET,"0.0.0.0",6379),(socket.AF_INET,"0.0.0.0",8084),(socket.AF_INET6,"::",444)]:\n s=socket.socket(family);s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind((address,port));s.listen()\n def serve(s):\n  while True:\n   c,a=s.accept();c.sendall(b"ok "+a[0].encode());c.close()\n threading.Thread(target=serve,args=(s,),daemon=True).start()\ntime.sleep(120)'

function localDocker() {
  const env = { ...process.env }
  let endpoint = env.DOCKER_HOST
  // Context metadata is local. An explicit context takes precedence over DOCKER_HOST.
  if (env.DOCKER_CONTEXT || !endpoint) {
    const args = ['context', 'inspect']
    if (env.DOCKER_CONTEXT) args.push(env.DOCKER_CONTEXT)
    args.push('--format', '{{.Endpoints.docker.Host}}')
    const result = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 20_000 })
    if (result.status !== 0 || typeof result.stdout !== 'string')
      throw new Error('Could not resolve Docker endpoint for firewall verification')
    endpoint = result.stdout.trim()
  }
  if (!/^(unix:\/\/\/[^\s?#]+|npipe:\/\/\/[/\\]\.\/pipe\/[^\s?#/\\]+)$/u.test(endpoint))
    throw new Error('Firewall verification requires a local Docker socket')
  // Pin the resolved socket for build, run and cleanup even if the selected context changes.
  // Drop transport and builder overrides: the fixture must stay on this local daemon.
  for (const key of [
    'DOCKER_CONTEXT',
    'DOCKER_HOST',
    'DOCKER_TLS',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
    'BUILDX_BUILDER',
  ])
    delete env[key]
  return { args: ['--host', endpoint], env }
}

// The privileged container owns a fresh network namespace, has --network none, no Docker
// socket, no host mounts and no host PID/network namespace. Nested namespaces emulate llm,
// PostgreSQL, core, web and external peers. No firewall command below runs on the Docker host.
export async function verifyLlmFirewall() {
  // Reject remote/unknown endpoints before creating resources or registering any cleanup.
  const connection = localDocker()
  const directory = await mkdtemp(join(tmpdir(), 'raditi-llm-firewall-'))
  const name = `raditi-llm-firewall-${process.pid}-${Date.now()}`
  const image = `${name}:test`
  let child
  let interrupted = false
  const interrupt = () => {
    interrupted = true
    child?.kill('SIGTERM')
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const docker = async (args, input, timeout = 180_000) => {
    if (interrupted) throw new Error('Firewall verification interrupted')
    return await new Promise((resolve, reject) => {
      child = spawn('docker', [...connection.args, ...args], {
        env: connection.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
      child.stdout.setEncoding('utf8').on('data', (value) => {
        stdout += value
      })
      child.stderr.setEncoding('utf8').on('data', (value) => {
        stderr += value
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        child = undefined
        if (code !== 0 || interrupted)
          reject(new Error(stderr || stdout || 'Firewall verification interrupted'))
        else resolve(stdout)
      })
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    })
  }
  try {
    await writeFile(
      join(directory, 'llm-firewall.mjs'),
      await readFile(new URL('./llm-firewall.mjs', import.meta.url)),
    )
    await writeFile(
      join(directory, 'Dockerfile'),
      await readFile(new URL('./verify/firewall.Dockerfile', import.meta.url)),
    )
    await docker(['build', '--quiet', '--tag', image, directory])
    const result = await docker(
      [
        'run',
        '--rm',
        '--name',
        name,
        '--privileged',
        '--network',
        'none',
        '--memory',
        '512m',
        '--cpus',
        '1',
        '--pids-limit',
        '128',
        '-i',
        image,
        'node',
        '--input-type=module',
      ],
      `
import assert from 'node:assert/strict';
import {spawnSync, spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {firewallConfig, manageFirewall, runFirewallCommand} from '/llm-firewall.mjs';
const run = (binary,args,input) => spawnSync(binary,args,{input,encoding:'utf8',timeout:10000});
const must = (binary,args) => {const r=run(binary,args);assert.equal(r.status,0,binary+' '+args.join(' ')+': '+r.stderr);return r.stdout;};
const ip=(...args)=>must('ip',args);
const ns=(name,...args)=>ip('netns','exec',name,...args);
assert.deepEqual(JSON.parse(ip('-j','route','show')),[]);
assert.ok(JSON.parse(ip('-j','link','show')).every(link=>link.ifname==='lo'||!link.flags.includes('UP')));
must('sysctl',['-w','net.ipv4.ip_forward=1']);
ip('link','set','lo','up');
for(const [bridge,address] of [['rd-llmout','172.29.84.1/24'],['rd-llmdb','172.29.85.1/24'],['rd-llmedge','172.29.86.1/24'],['rd-core','172.29.87.1/24'],['rd-web','172.29.88.1/24']]){
  ip('link','add',bridge,'type','bridge');ip('addr','add',address,'dev',bridge);ip('link','set',bridge,'up');
}
function peer(name,bridge,address){
  ip('netns','add',name);ip('link','add',name+'h','type','veth','peer','name',name+'p');
  ip('link','set',name+'h','master',bridge);ip('link','set',name+'h','up');ip('link','set',name+'p','netns',name);
  ns(name,'ip','link','set','lo','up');ns(name,'ip','link','set',name+'p','up');ns(name,'ip','addr','add',address,'dev',name+'p');
}
peer('out','rd-llmout','172.29.84.2/24');ns('out','ip','route','add','default','via','172.29.84.1');
peer('dbclient','rd-llmdb','172.29.85.2/24');ns('dbclient','ip','route','add','default','via','172.29.85.1');
peer('db','rd-llmdb','172.29.85.3/24');ns('db','ip','route','add','default','via','172.29.85.1');
peer('edge','rd-llmedge','172.29.86.2/24');ns('edge','ip','route','add','default','via','172.29.86.1');
peer('core','rd-core','172.29.87.2/24');ns('core','ip','route','add','default','via','172.29.87.1');
peer('web','rd-web','172.29.88.2/24');ns('web','ip','route','add','default','via','172.29.88.1');
// remote: a sandbox VM (and the proxy/Vault addresses below); other: any other host.
for(const [name,net] of [['remote','10.250.0'],['other','10.251.0']]){
  ip('netns','add',name);ip('link','add',name+'h','type','veth','peer','name',name+'p');
  ip('addr','add',net+'.1/24','dev',name+'h');ip('link','set',name+'h','up');ip('link','set',name+'p','netns',name);
  ns(name,'ip','link','set','lo','up');ns(name,'ip','link','set',name+'p','up');ns(name,'ip','addr','add',net+'.2/24','dev',name+'p');
  ns(name,'ip','route','add','default','via',net+'.1');
}
// The published gateway port on the private address of the VM, as Docker's NAT makes it.
ip('addr','add','10.10.0.10/32','dev','lo');
writeFileSync('/tmp/published.nft',${JSON.stringify(published)});must('/usr/sbin/nft',['-f','/tmp/published.nft']);
for(const address of ['93.184.216.34','93.184.216.35','10.10.0.20','169.254.169.254']){
 ns('remote','ip','addr','add',address+'/32','dev','lo');ip('route','add',address+'/32','via','10.250.0.2');
}
// IPv6 remains blocked even if an operator accidentally enables it on a bridge/container.
ip('-6','addr','add','fd00:84::1/64','dev','rd-llmout','nodad');
ns('out','ip','-6','addr','add','fd00:84::2/64','dev','outp','nodad');
const server=${JSON.stringify(serverPython)};
const children=[spawn('python3',['-c',server]),...['remote','db','edge','out'].map(n=>spawn('ip',['netns','exec',n,'python3','-c',server]))];
await new Promise(r=>setTimeout(r,300));
const connect=(namespace,address,port)=>run('ip',['netns','exec',namespace,'python3','-c','import socket,sys;s=socket.create_connection((sys.argv[1],int(sys.argv[2])),.5);assert s.recv(2)==b"ok"',address,String(port)]).status===0;
// The peer address the server reports, or null without a connection.
const seen=(namespace,address,port)=>{const r=run('ip',['netns','exec',namespace,'python3','-c','import socket,sys;s=socket.create_connection((sys.argv[1],int(sys.argv[2])),.5);print(s.recv(64).decode())',address,String(port)]);return r.status===0&&r.stdout.startsWith('ok ')?r.stdout.trim().slice(3):null;};
// Prove the denied endpoints are actually listening before installing the policy.
for(const [n,a,p] of [['out','93.184.216.35',443],['out','169.254.169.254',443],['out','172.29.84.1',6379],['dbclient','172.29.85.3',6379],['edge','93.184.216.34',443],['out','fd00:84::1',444],['other','10.10.0.10',8084],['other','172.29.84.2',8084],['remote','172.29.84.2',443],['core','172.29.84.2',443],['remote','172.29.86.2',8084],['remote','172.29.85.3',5432]]) assert.ok(connect(n,a,p),'baseline '+n+' '+a+':'+p);
// Without the policy web reaches the gateway exactly as core does: llm sees its own bridge
// gateway as the source of both, so the client CIDR list cannot tell them apart.
for(const n of ['core','web']) assert.equal(seen(n,'10.10.0.10',8084),'172.29.84.1','baseline '+n+' through the published port');
const config=firewallConfig(${JSON.stringify(settings)});
// br_netfilter is already loaded by this Docker kernel; never load a module from the test.
const commands=(binary,args,input)=>{
 if(binary.endsWith('/modprobe'))return {status:0,stdout:''};
 const result=runFirewallCommand(binary,args,input);
 if(args.includes('--file')&&result.status!==0)throw new Error(result.stderr);
 return result;
};
manageFirewall('apply',config,commands);manageFirewall('apply',config,commands);manageFirewall('check',config,commands);
for(const [n,a,p] of [['out','93.184.216.34',443],['out','10.10.0.20',8200],['dbclient','172.29.85.3',5432]]) assert.ok(connect(n,a,p),'allowed '+n+' '+a+':'+p);
// Into llm: core by its bridge (still seen as the gateway), a sandbox VM by its own address.
assert.equal(seen('core','10.10.0.10',8084),'172.29.84.1','allowed core through the published port');
assert.equal(seen('remote','10.10.0.10',8084),'10.250.0.2','allowed sandbox through the published port');
for(const [n,a,p] of [['out','93.184.216.35',443],['out','93.184.216.34',8200],['out','10.10.0.20',443],['out','169.254.169.254',443],['out','172.29.84.1',6379],['out','172.29.84.1',443],['dbclient','172.29.85.3',6379],['dbclient','93.184.216.34',443],['edge','93.184.216.34',443],['out','fd00:84::1',444],['web','10.10.0.10',8084],['other','10.10.0.10',8084],['other','172.29.84.2',8084],['remote','172.29.84.2',443],['core','172.29.84.2',443],['remote','172.29.86.2',8084],['remote','172.29.85.3',5432]]) assert.equal(connect(n,a,p),false,'blocked '+n+' '+a+':'+p);
const disabled=firewallConfig('COMPOSE_PROFILES=');
manageFirewall('apply',disabled,commands);assert.equal(connect('out','93.184.216.34',443),false);
for(const n of ['core','remote']) assert.equal(connect(n,'10.10.0.10',8084),false,'disabled '+n);
// A reboot loses the in-kernel rules. An old restartable llm container is still denied when
// its Compose profile is disabled and the remaining proxy/Vault settings have been removed.
must('/usr/sbin/nft',['delete','table','inet','raditi_llm']);
manageFirewall('apply',disabled,commands);manageFirewall('check',disabled,commands);
assert.equal(connect('out','93.184.216.34',443),false);
manageFirewall('apply',config,commands);
must('/usr/sbin/nft',['insert','rule','inet','raditi_llm','from_out','accept']);
assert.throws(()=>manageFirewall('check',config,commands));
manageFirewall('apply',config,commands);assert.equal(connect('out','93.184.216.35',443),false);
must('/usr/sbin/nft',['insert','rule','inet','raditi_llm','to_llm','accept']);
assert.throws(()=>manageFirewall('check',config,commands));
manageFirewall('apply',config,commands);assert.equal(connect('web','10.10.0.10',8084),false);
children.forEach(child=>child.kill());console.log('packet proof passed: allowed routes, forbidden routes, inbound sources, host INPUT, IPv6, replies, idempotence, disabled profile, tamper detection');
`,
      60_000,
    )
    assert.match(result, /packet proof passed/u)
  } finally {
    const cleanupOptions = { env: connection.env, stdio: 'ignore', timeout: 20_000 }
    spawnSync('docker', [...connection.args, 'rm', '--force', name], cleanupOptions)
    spawnSync('docker', [...connection.args, 'image', 'rm', image], cleanupOptions)
    await rm(directory, { recursive: true, force: true })
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    for (const args of [
      ['ps', '--all', '--filter', `name=^${name}$`, '--format', '{{.ID}}'],
      ['image', 'ls', '--filter', `reference=${image}`, '--format', '{{.ID}}'],
    ]) {
      const remaining = spawnSync('docker', [...connection.args, ...args], {
        env: connection.env,
        encoding: 'utf8',
        timeout: 20_000,
      })
      assert.equal(remaining.status, 0, 'Could not verify cleanup of the owned firewall fixture')
      assert.equal(remaining.stdout.trim(), '', 'Owned firewall fixture resources remain')
    }
  }
}

if (import.meta.main) {
  if (process.argv.length !== 2) throw new Error('Usage: node verify-llm-firewall.mjs')
  try {
    await verifyLlmFirewall()
    console.log('llm firewall: isolated Linux packet verification passed; owned resources removed')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
