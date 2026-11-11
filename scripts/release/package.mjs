/** Offline preparation only. No production keys, signing service, download or installer. */
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const DOMAIN = 'Cyrene/QFCA/package-manifest/v1\0';
export const LIMITS = Object.freeze({ manifest: 256 * 1024, count: 2048, file: 32 * 1024 * 1024, total: 64 * 1024 * 1024, transport: 92 * 1024 * 1024 });
export const ENTRY = 'dist/runtime/entry.js';
export const API = Object.freeze({ major: 1, minMinor: 0, maxMinor: 0 });
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
const stable = v => typeof v === 'string' && /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(v);
const keyId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export function validPath(path) {
  return typeof path === 'string' && path.length <= 240 && path.split('/').every(p => /^[a-zA-Z0-9_@][a-zA-Z0-9_.@-]{0,63}$/.test(p) && !p.endsWith('.') && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p));
}
export function validatePlan(plan) {
  if (!exact(plan, ['version', 'releaseSequence', 'keyId', 'issuedAt', 'expiresAt', 'hostVersionRange', 'targets'])
    || !stable(plan.version) || !integer(plan.releaseSequence) || plan.releaseSequence === 0 || !keyId(plan.keyId)
    || !integer(plan.issuedAt) || !integer(plan.expiresAt) || plan.expiresAt <= plan.issuedAt
    || !exact(plan.hostVersionRange, ['minInclusive', 'maxExclusive']) || !Object.values(plan.hostVersionRange).every(stable)
    || compare(plan.hostVersionRange.minInclusive, plan.hostVersionRange.maxExclusive) >= 0
    || !Array.isArray(plan.targets) || plan.targets.length < 1 || plan.targets.length > 6
    || !plan.targets.every(t => exact(t, ['platform', 'arch']) && ['win32', 'darwin', 'linux'].includes(t.platform) && ['x64', 'arm64'].includes(t.arch))
    || new Set(plan.targets.map(t => `${t.platform}/${t.arch}`)).size !== plan.targets.length) fail('invalid-explicit-release-plan');
  return { version: plan.version, releaseSequence: plan.releaseSequence, keyId: plan.keyId, issuedAt: plan.issuedAt, expiresAt: plan.expiresAt,
    hostVersionRange: { minInclusive: plan.hostVersionRange.minInclusive, maxExclusive: plan.hostVersionRange.maxExclusive },
    targets: plan.targets.map(t => ({ platform: t.platform, arch: t.arch })).sort((a, b) => `${a.platform}/${a.arch}` < `${b.platform}/${b.arch}` ? -1 : 1) };
}
export function inventory(files) {
  if (!(files instanceof Map) || files.size < 1 || files.size > LIMITS.count) fail('invalid-file-inventory');
  const lower = new Set(), dirs = new Map(); let total = 0;
  const result = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => {
    if (!validPath(path) || !(bytes instanceof Uint8Array) || bytes.length > LIMITS.file) fail('invalid-file-inventory');
    if (lower.has(path.toLowerCase())) fail('invalid-file-inventory'); lower.add(path.toLowerCase());
    const parts = path.split('/');
    while (parts.length > 1) { parts.pop(); const p = parts.join('/'), key = p.toLowerCase(); if (dirs.has(key) && dirs.get(key) !== p) fail('invalid-file-inventory'); dirs.set(key, p); }
    total += bytes.length; if (total > LIMITS.total) fail('package-too-large');
    return { path, size: bytes.length, sha256: digest(bytes) };
  });
  for (const dir of dirs.keys()) if (lower.has(dir)) fail('invalid-file-inventory');
  return result;
}
export function createCandidate(plan, files) {
  const p = validatePlan(plan), entries = inventory(files);
  if (!files.has(ENTRY)) fail('missing-runtime-entry');
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, moduleId: 'qfca', version: p.version, releaseSequence: p.releaseSequence,
    keyId: p.keyId, issuedAt: p.issuedAt, expiresAt: p.expiresAt, hostVersionRange: p.hostVersionRange, apiSupport: API, targets: p.targets, entry: ENTRY, files: entries }));
  if (manifest.length > LIMITS.manifest) fail('manifest-too-large');
  return { manifest, files: new Map(entries.map(f => [f.path, Buffer.from(files.get(f.path))])) };
}
/** No archive extraction. A transport object is inert and confers no publisher trust. */
export function encodeUnsigned(candidate) {
  const manifest = JSON.parse(Buffer.from(candidate.manifest).toString('utf8'));
  const checked = createCandidate(Object.fromEntries(['version', 'releaseSequence', 'keyId', 'issuedAt', 'expiresAt', 'hostVersionRange', 'targets'].map(k => [k, manifest[k]])), candidate.files);
  if (!checked.manifest.equals(Buffer.from(candidate.manifest))) fail('invalid-candidate');
  const bytes = Buffer.from(JSON.stringify({ format: 'qfca-unsigned-candidate-v1', manifest: Buffer.from(candidate.manifest).toString('base64'),
    files: [...checked.files].map(([path, data]) => ({ path, data: data.toString('base64') })) }));
  if (bytes.length > LIMITS.transport) fail('transport-too-large');
  return bytes;
}
function base64(value, max) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(max / 3)) fail('invalid-base64');
  const bytes = Buffer.from(value, 'base64'); if (bytes.length > max || bytes.toString('base64') !== value) fail('invalid-base64'); return bytes;
}
export function decodeUnsigned(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > LIMITS.transport) fail('transport-too-large');
  let value; try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { fail('invalid-transport'); }
  if (!Buffer.from(JSON.stringify(value)).equals(Buffer.from(bytes)) || !exact(value, ['format', 'manifest', 'files'])
    || value.format !== 'qfca-unsigned-candidate-v1' || !Array.isArray(value.files) || value.files.length > LIMITS.count) fail('invalid-transport');
  const manifest = base64(value.manifest, LIMITS.manifest), files = new Map(); let total = 0;
  for (const file of value.files) {
    if (!exact(file, ['path', 'data']) || !validPath(file.path) || files.has(file.path)) fail('invalid-file-inventory');
    const data = base64(file.data, LIMITS.file); total += data.length; if (total > LIMITS.total) fail('package-too-large'); files.set(file.path, data);
  }
  const result = { manifest, files }; if (!encodeUnsigned(result).equals(Buffer.from(bytes))) fail('invalid-transport'); return result;
}
function regular(path, max = LIMITS.file) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) fail('unsafe-input-file');
  const bytes = readFileSync(path); if (bytes.length > max) fail('unsafe-input-file'); return bytes;
}
export function readPortableTree(path, prefix = '') {
  const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe-input-directory');
  const files = new Map();
  for (const name of readdirSync(path).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name; if (!validPath(rel)) fail('unsafe-input-path');
    const child = join(path, name), st = lstatSync(child);
    if (st.isDirectory() && !st.isSymbolicLink()) for (const entry of readPortableTree(child, rel)) files.set(...entry);
    else files.set(rel, regular(child));
    if (files.size > LIMITS.count) fail('too-many-input-files');
  }
  return files;
}
/** Exact package-lock input; npm may read cache only and cannot run lifecycle scripts. */
export function buildCandidate(plan, { root = ROOT, cache } = {}) {
  root = resolve(root);
  const source = path => {
    let parent = root;
    for (const part of ['', ...path.split('/').slice(0, -1)]) {
      parent = join(parent, part); const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe-input-directory');
    }
    return regular(join(root, path));
  };
  const p = validatePlan(plan), pkgBytes = source('package.json'), lockBytes = source('package-lock.json');
  const pkg = JSON.parse(pkgBytes), lock = JSON.parse(lockBytes), wsLock = lock.packages?.['node_modules/ws'];
  if (pkg.name !== 'qfca' || pkg.version !== lock.packages?.['']?.version || JSON.stringify(pkg.dependencies) !== '{"ws":"8.21.0"}'
    || JSON.stringify(lock.packages?.['']?.dependencies) !== JSON.stringify(pkg.dependencies) || wsLock?.version !== '8.21.0'
    || wsLock.resolved !== 'https://registry.npmjs.org/ws/-/ws-8.21.0.tgz' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(wsLock.integrity ?? '')) fail('unreviewed-runtime-dependency');
  if (process.versions.node.split('.')[0] !== '24') fail('unsupported-build-node');
  const npm = process.env.npm_execpath; if (!npm || !npm.endsWith('npm-cli.js')) fail('run-through-npm-script');
  const tscPackage = require.resolve('typescript/package.json'), tsc = join(dirname(tscPackage), 'bin/tsc');
  if (JSON.parse(readFileSync(tscPackage)).version !== pkg.devDependencies.typescript
    || lock.packages?.['node_modules/typescript']?.version !== pkg.devDependencies.typescript) fail('unlocked-typescript');
  const work = mkdtempSync(join(tmpdir(), 'qfca-build-'));
  try {
    execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json'), '--outDir', join(work, 'compiled'), '--newLine', 'lf'], { cwd: root, stdio: 'pipe' });
    const deps = join(work, 'deps'); mkdirSync(deps);
    writeFileSync(join(deps, 'package.json'), pkgBytes); writeFileSync(join(deps, 'package-lock.json'), lockBytes);
    execFileSync(process.execPath, [npm, 'ci', '--offline', '--ignore-scripts', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', ...(cache ? ['--cache', resolve(cache)] : [])],
      { cwd: deps, stdio: 'pipe', env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_offline: 'true' } });
    const dependencyNames = readdirSync(join(deps, 'node_modules')).filter(n => n !== '.package-lock.json').sort();
    if (JSON.stringify(dependencyNames) !== '["ws"]') fail('unexpected-runtime-dependency');
    const ws = readPortableTree(join(deps, 'node_modules/ws')), metadata = JSON.parse(ws.get('package.json'));
    if (metadata.name !== 'ws' || metadata.version !== wsLock.version || metadata.license !== 'MIT'
      || Object.keys(metadata.dependencies ?? {}).length || Object.keys(metadata.optionalDependencies ?? {}).length
      || JSON.stringify(metadata.peerDependencies) !== '{"bufferutil":"^4.0.1","utf-8-validate":">=5.0.2"}'
      || Object.values(metadata.peerDependenciesMeta ?? {}).some(v => v.optional !== true)) fail('unreviewed-runtime-dependency');
    if (!['index.js', 'wrapper.mjs', 'browser.js', 'LICENSE', 'package.json', 'lib/websocket.js', 'lib/websocket-server.js'].every(f => ws.has(f))) fail('incomplete-runtime-dependency');
    const files = new Map();
    for (const [path, bytes] of readPortableTree(join(work, 'compiled'))) { if (!path.endsWith('.js') && !path.endsWith('.d.ts')) fail('unexpected-compiled-file'); files.set(`dist/${path}`, bytes); }
    for (const [path, bytes] of ws) { if (!['LICENSE', 'README.md', 'package.json', 'index.js', 'wrapper.mjs', 'browser.js'].includes(path) && !/^lib\/[A-Za-z0-9_-]+\.js$/.test(path)) fail('unexpected-dependency-file'); files.set(`node_modules/ws/${path}`, bytes); }
    for (const path of ['LICENSE', 'NOTICE', 'LICENSES/Cyrene-Agent-MIT.txt', 'docs/contract-provenance.json']) files.set(path, source(path));
    const sourceFiles = new Map();
    for (const directory of ['src', 'scripts/release']) for (const [path, bytes] of readPortableTree(join(root, directory))) sourceFiles.set(`${directory}/${path}`, bytes);
    for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'LICENSE', 'NOTICE', 'LICENSES/Cyrene-Agent-MIT.txt', 'docs/contract-provenance.json']) sourceFiles.set(path, source(path));
    const contract = JSON.parse(source('docs/contract-provenance.json'));
    for (const [path, expected] of Object.entries(contract.sha256 ?? {})) {
      if (!validPath(path) || digest(source(`src/contract/${path}`)) !== expected) fail('contract-provenance-mismatch');
    }
    if (Object.keys(contract.sha256 ?? {}).length !== 9) fail('contract-provenance-mismatch');
    const sourceInventory = inventory(sourceFiles);
    files.set('package.json', Buffer.from(JSON.stringify({ name: 'qfca', version: p.version, private: true, description: 'Unsigned QFCA offline candidate; no production trust configured',
      license: 'MIT', main: 'dist/index.js', types: 'dist/index.d.ts', engines: pkg.engines, dependencies: pkg.dependencies })));
    files.set('docs/build-provenance.json', Buffer.from(JSON.stringify({ format: 1, purpose: 'offline-candidate-only', node: process.versions.node, buildPlatform: process.platform, buildArch: process.arch,
      typescript: pkg.devDependencies.typescript, sourceVersion: pkg.version, candidateVersion: p.version, sourceTreeSha256: digest(Buffer.from(JSON.stringify(sourceInventory))), sourceFiles: sourceInventory,
      packageLockSha256: digest(lockBytes), runtimeDependencies: [{ name: 'ws', version: wsLock.version, integrity: wsLock.integrity, license: 'MIT', optionalNativePeers: 'disabled' }] })));
    return createCandidate(p, files);
  } finally { rmSync(work, { recursive: true, force: true }); }
}
/** Test-only keys never leave memory and are never saved or installed as a trust root. */
export function rehearse(candidate) {
  encodeUnsigned(candidate); // Check the complete payload before signing any bytes.
  const keys = generateKeyPairSync('ed25519'), message = Buffer.concat([Buffer.from(DOMAIN), candidate.manifest]);
  const signature = sign(null, message, keys.privateKey);
  if (signature.length !== 64 || !verify(null, message, keys.publicKey, signature)
    || !sign(null, message, keys.privateKey).equals(signature)) fail('rehearsal-signature-failed');
  return { signatureBytes: signature.length, manifestSha256: digest(candidate.manifest), payloadFiles: candidate.files.size,
    publisherTrust: 'unconfigured', productionEnabled: false };
}
