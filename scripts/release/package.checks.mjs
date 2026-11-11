import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fork, execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { API, DOMAIN, ENTRY, LIMITS, ROOT, buildCandidate, createCandidate, decodeUnsigned, digest, encodeUnsigned, inventory, rehearse, readPortableTree, validatePlan, validPath } from './package.mjs';

const plan = JSON.parse(readFileSync(new URL('./rehearsal-plan.json', import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'qfca-release-test-'));
after(() => rmSync(temp, { recursive: true, force: true }));
const options = { cache: process.env.QFCA_NPM_CACHE };
let candidate;
function built() { return candidate ??= buildCandidate(plan, options); }
const minimal = () => createCandidate(plan, new Map([[ENTRY, Buffer.from('// inert fixture')], ['LICENSE', Buffer.from('fixture only')]]));
function materialize(input, path) {
  mkdirSync(path, { recursive: true });
  for (const [relative, bytes] of input.files) { mkdirSync(dirname(join(path, relative)), { recursive: true }); writeFileSync(join(path, relative), bytes); }
}
async function handshake(payload, expectedVersion = plan.version) {
  const child = fork(join(payload, ENTRY), [], { cwd: payload, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { NODE_ENV: 'test', WS_NO_BUFFER_UTIL: '', WS_NO_UTF_8_VALIDATE: '' } });
  let stderr = '', seq = 0; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  function request(method) {
    const id = `release_${++seq}`;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); child.off('message', receive); child.off('exit', exit); child.off('error', reject); };
      const receive = response => { if (response.responseTo === id) { cleanup(); response.ok ? resolve(response.payload) : reject(new Error(response.error.code)); } };
      const exit = () => { cleanup(); reject(new Error(`child-exit:${stderr}`)); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error('handshake-timeout')); }, 5000);
      child.on('message', receive); child.once('exit', exit); child.once('error', reject);
      child.send({ kind: 'request', apiVersion: { major: 1, minor: 0 }, instanceId: 'release', runtimeEpoch: 1, requestId: id, method, payload: {} });
    });
  }
  try {
    const hello = await request('hello'); assert.equal(hello.moduleId, 'qfca'); assert.equal(hello.moduleVersion, expectedVersion); assert.deepEqual(hello.apiSupport, API);
    await request('stop'); child.disconnect();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    assert.deepEqual(await exited, { code: 0, signal: null }); clearTimeout(timeout); assert.equal(stderr, '');
  } finally { if (child.connected) child.disconnect(); child.kill(); }
}

test('requires all explicit stable version, ordering, time, range and target inputs', () => {
  for (const version of ['0.1.0-dev.0', '01.2.3', '1.2', '1.2.3+build', '', 123]) assert.throws(() => validatePlan({ ...plan, version }), /invalid-explicit-release-plan/);
  for (const releaseSequence of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validatePlan({ ...plan, releaseSequence }));
  for (const patch of [{ expiresAt: plan.issuedAt }, { issuedAt: -1 }, { keyId: '../secret' }, { targets: [] }, { targets: [...plan.targets, ...plan.targets] },
    { targets: [{ platform: 'windows', arch: 'x64' }] }, { targets: [{ platform: 'linux', arch: 'ia32' }] }, { hostVersionRange: { minInclusive: '2.0.0', maxExclusive: '1.0.0' } },
    { publicKey: 'never' }]) assert.throws(() => validatePlan({ ...plan, ...patch }));
  for (const key of Object.keys(plan)) { const missing = { ...plan }; delete missing[key]; assert.throws(() => validatePlan(missing)); }
  assert.equal(validatePlan(plan).version, '0.0.0');
});
test('portable inventory rejects traversal, links spelling, collisions and unsafe file sizes', () => {
  for (const path of ['../x', '/x', 'C:/x', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'a:stream', 'CON', 'nul.js', 'COM1.txt', 'dir/file.', 'é.js', '']) { assert.equal(validPath(path), false); assert.throws(() => inventory(new Map([[path, Buffer.from('')]]))); }
  for (const paths of [['A.js', 'a.js'], ['Lib/a.js', 'lib/b.js'], ['lib/a.js', 'lib/a.js/x']]) assert.throws(() => inventory(new Map(paths.map(path => [path, Buffer.from('')]))));
  assert.throws(() => inventory(new Map([['big', Buffer.alloc(LIMITS.file + 1)]])));
  assert.throws(() => inventory(new Map(Array.from({ length: LIMITS.count + 1 }, (_, n) => [`x${n}`, Buffer.from('')]))));
});
test('canonical transport rejects hidden fields, duplicate keys, malformed base64, tampering and missing/extra files', () => {
  const good = encodeUnsigned(minimal()), value = JSON.parse(good);
  assert.ok(encodeUnsigned(decodeUnsigned(good)).equals(good));
  const malformed = [Buffer.concat([Buffer.from(' '), good]), Buffer.from(good.toString().replace('"format":', '"format":"bad","format":')),
    Buffer.from(JSON.stringify({ ...value, signature: 'not-signed' })), Buffer.from(JSON.stringify({ ...value, manifest: `${value.manifest}\n` }))];
  for (const bytes of malformed) assert.throws(() => decodeUnsigned(bytes));
  for (const files of [[], value.files.slice(1), [...value.files, { path: 'extra', data: '' }], [...value.files, value.files[0]], value.files.map((f, i) => i ? f : { ...f, data: 'AA==' })]) assert.throws(() => decodeUnsigned(Buffer.from(JSON.stringify({ ...value, files }))));
  const large = createCandidate(plan, new Map([[ENTRY, Buffer.alloc(2 * 1024 * 1024, 3)]]));
  assert.equal(decodeUnsigned(encodeUnsigned(large)).files.get(ENTRY).length, 2 * 1024 * 1024);
});
test('clean compiler and offline lock install produce byte-identical payload and explicit coherent versions', () => {
  const first = built(), second = buildCandidate(plan, options);
  assert.ok(encodeUnsigned(first).equals(encodeUnsigned(second)));
  const manifest = JSON.parse(first.manifest), pkg = JSON.parse(first.files.get('package.json'));
  assert.equal(manifest.version, pkg.version); assert.equal(manifest.entry, ENTRY); assert.equal(pkg.version, plan.version);
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'))).version, '0.1.0-dev.0');
  for (const path of ['LICENSE', 'NOTICE', 'LICENSES/Cyrene-Agent-MIT.txt', 'node_modules/ws/LICENSE', 'node_modules/ws/package.json', 'docs/build-provenance.json']) assert.ok(first.files.has(path), path);
  assert.equal(JSON.parse(first.files.get('node_modules/ws/package.json')).version, '8.21.0');
  assert.ok([...first.files.keys()].every(path => !path.endsWith('.test.js') && !path.endsWith('.node') && !path.includes('bufferutil') && !path.includes('utf-8-validate')));
  assert.ok(!first.files.has('package-lock.json'));
  assert.equal(JSON.parse(first.files.get('docs/build-provenance.json')).packageLockSha256, digest(readFileSync(join(ROOT, 'package-lock.json'))));
  assert.ok(!first.manifest.equals(createCandidate({ ...plan, releaseSequence: 2 }, first.files).manifest));
});
test('same ephemeral in-memory key reproduces signature; corruption and a different key fail', () => {
  const input = built(), keys = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
  const message = Buffer.concat([Buffer.from(DOMAIN), input.manifest]), signature = sign(null, message, keys.privateKey);
  assert.equal(signature.length, 64); assert.ok(verify(null, message, keys.publicKey, signature));
  assert.ok(signature.equals(sign(null, message, keys.privateKey)));
  assert.equal(verify(null, Buffer.concat([message, Buffer.from('\n')]), keys.publicKey, signature), false);
  assert.equal(verify(null, message, other.publicKey, signature), false);
  const changed = Buffer.from(signature); changed[0] ^= 1; assert.equal(verify(null, message, keys.publicKey, changed), false);
  const tampered = { ...input, files: new Map(input.files) }; tampered.files.set('LICENSE', Buffer.from('changed'));
  assert.throws(() => rehearse(tampered), /invalid-candidate/);
  assert.deepEqual(Object.keys(rehearse(input)).sort(), ['manifestSha256', 'payloadFiles', 'productionEnabled', 'publisherTrust', 'signatureBytes']);
});
test('isolated payload starts with its own ws, coherent hello and native peer loading disabled', async () => {
  const payload = join(temp, 'runtime'), marker = join(temp, 'native-loaded'); materialize(built(), payload);
  for (const name of ['bufferutil', 'utf-8-validate']) {
    const dir = join(temp, 'node_modules', name); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'); throw Error('external native peer loaded');`);
  }
  await handshake(payload); assert.equal(existsSync(marker), false);
  // Required dependency files cannot be omitted even though the source checkout has ws.
  rmSync(join(payload, 'node_modules/ws/lib/websocket.js'));
  await assert.rejects(handshake(payload), /child-exit/);
});
test('CLI leaves production unconfigured and refuses overwrite without replacing an existing file', () => {
  const out = join(temp, 'existing.json'); writeFileSync(out, 'keep');
  const env = { ...process.env, QFCA_NPM_CACHE: process.env.QFCA_NPM_CACHE ?? '' };
  assert.throws(() => execFileSync(process.execPath, [join(ROOT, 'scripts/release/cli.mjs'), 'prepare', join(ROOT, 'scripts/release/rehearsal-plan.json'), out], { env, stdio: 'pipe' }));
  assert.equal(readFileSync(out, 'utf8'), 'keep');
});

test('input traversal rejects soft links, hard links, device-like paths and unsafe input directories', () => {
  const dir = join(temp, 'input-tree'); mkdirSync(dir); writeFileSync(join(dir, 'file.js'), 'fixture');
  assert.equal(readPortableTree(dir).size, 1);
  const hard = join(dir, 'alias.js'); linkSync(join(dir, 'file.js'), hard);
  assert.throws(() => readPortableTree(dir), /unsafe-input-file/); rmSync(hard);
  if (process.platform !== 'win32') {
    symlinkSync(join(dir, 'file.js'), join(dir, 'soft.js'));
    assert.throws(() => readPortableTree(dir), /unsafe-input-file/); rmSync(join(dir, 'soft.js'));
    symlinkSync(dir, join(temp, 'link-directory'), 'dir');
    assert.throws(() => readPortableTree(join(temp, 'link-directory')), /unsafe-input-directory/);
    writeFileSync(join(dir, 'nul.js'), 'fixture'); assert.throws(() => readPortableTree(dir), /unsafe-input-path/);
  }
});

test('repository attributes retain exact LF provenance bytes with core.autocrlf=true', () => {
  const dir = join(temp, 'autocrlf'); mkdirSync(dir);
  execFileSync('git', ['-c', 'core.autocrlf=true', 'init', dir], { stdio: 'pipe' });
  writeFileSync(join(dir, '.gitattributes'), readFileSync(join(ROOT, '.gitattributes')));
  const original = readFileSync(join(ROOT, 'src/contract/version.ts'));
  writeFileSync(join(dir, 'version.ts'), original);
  execFileSync('git', ['-c', 'core.autocrlf=true', 'add', '.gitattributes', 'version.ts'], { cwd: dir, stdio: 'pipe' });
  rmSync(join(dir, 'version.ts'));
  execFileSync('git', ['-c', 'core.autocrlf=true', 'checkout', '--', 'version.ts'], { cwd: dir, stdio: 'pipe' });
  assert.ok(readFileSync(join(dir, 'version.ts')).equals(original));
});
