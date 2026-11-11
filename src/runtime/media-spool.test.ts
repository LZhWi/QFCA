import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaSpool, MEDIA_LIMITS, decodeChunk, recoverStaleSpools, isPrivateSpoolDirectory, type UploadBinding } from './media-spool';
const spools: MediaSpool[] = [];
afterEach(() => { for (const spool of spools.splice(0)) spool.dispose(); });
function fixture(now?: () => number) { const spool = new MediaSpool(now); spools.push(spool); return spool; }
const bytes = Buffer.from('hello media');
const binding = (extra: Partial<UploadBinding> = {}): UploadBinding => ({ connectionEpoch: 1, operationId: 'op', conversation: { type: 'private', peerId: '123' }, media: { kind: 'file', size: bytes.length }, sha256: createHash('sha256').update(bytes).digest('hex'), ...extra });
describe('MediaSpool', () => {
  it('seals hash-verified bytes, binds operation/conversation/kind/epoch and consumes once', () => {
    const spool = fixture(); const b = binding(); const { mediaId } = spool.begin(b);
    expect(() => spool.claim(b, { kind: 'file', mediaId })).toThrow();
    spool.write(1, mediaId, 0, bytes.toString('base64'));
    for (const wrong of [{ ...b, operationId: 'other' }, { ...b, connectionEpoch: 2 }, { ...b, conversation: { type: 'group' as const, groupId: '123' } }]) expect(() => spool.claim(wrong, { kind: 'file', mediaId })).toThrow();
    expect(() => spool.claim(b, { kind: 'image', mediaId })).toThrow();
    expect(() => spool.claim(b, { kind: 'file', mediaId, size: 999 })).toThrow();
    expect(spool.claim(b, { kind: 'file', mediaId }).read(0).data).toBe(bytes.toString('base64'));
    expect(() => spool.claim(b, { kind: 'file', mediaId })).toThrow();
    spool.release(1, mediaId); expect(() => spool.release(1, mediaId)).toThrow();
  });
  it.each(['a===', 'aA', 'aA==\n', 'aB==', Buffer.alloc(65537).toString('base64'), ''])('rejects noncanonical or oversized chunk', (data) => { expect(() => decodeChunk(data)).toThrow(); });
  it('revokes transfers on bad offset, excess bytes, duplicate final chunk and hash mismatch', () => {
    for (const mode of ['offset', 'size', 'hash', 'replay']) {
      const spool = fixture(); const b = binding(mode === 'hash' ? { sha256: '0'.repeat(64) } : {}); const { mediaId } = spool.begin(b);
      if (mode === 'replay') spool.write(1, mediaId, 0, bytes.toString('base64'));
      expect(() => spool.write(1, mediaId, mode === 'offset' ? 1 : 0, (mode === 'size' ? Buffer.alloc(bytes.length + 1) : bytes).toString('base64'))).toThrow();
      expect(() => spool.claim(b, { kind: 'file', mediaId })).toThrow();
    }
  });
  it('binds incoming reads to event and requires sequential bounded offsets', () => {
    const spool = fixture(); const media = spool.beginInbound(1, 'event', { kind: 'file', size: bytes.length });
    spool.write(1, media.mediaId, 0, bytes.toString('base64'), true);
    expect(() => spool.read(1, media.mediaId, 'wrong', 0, 5)).toThrow();
    expect(spool.read(1, media.mediaId, 'event', 0, 5).eof).toBe(false);
    expect(() => spool.read(1, media.mediaId, 'event', 0, 5)).toThrow();
    expect(spool.read(1, media.mediaId, 'event', 5, 65536).eof).toBe(true);
    expect(() => spool.claim(binding(), media)).toThrow();
  });
  it('reserves advertised capacity, bounds each file and frees on revoke/expiry', () => {
    let now = 0; const spool = fixture(() => now);
    expect(() => spool.begin(binding({ media: { kind: 'file', size: MEDIA_LIMITS.fileBytes + 1 } }))).toThrow();
    const handles = Array.from({ length: 5 }, () => spool.begin(binding({ media: { kind: 'file', size: MEDIA_LIMITS.fileBytes } })));
    expect(() => spool.begin(binding({ media: { kind: 'file', size: MEDIA_LIMITS.fileBytes } }))).toThrow();
    now = MEDIA_LIMITS.ttlMs; spool.sweep();
    expect(() => spool.write(1, handles[0].mediaId, 0, bytes.toString('base64'))).toThrow();
    const next = spool.begin(binding()); spool.revoke();
    expect(() => spool.write(1, next.mediaId, 0, bytes.toString('base64'))).toThrow();
  });
});

it('streams an actual 100MiB file using 64KiB memory chunks and releases it', () => {
  const spool = fixture(); const chunk = Buffer.alloc(MEDIA_LIMITS.chunkBytes, 0x61);
  const hash = createHash('sha256');
  for (let offset = 0; offset < MEDIA_LIMITS.fileBytes; offset += chunk.length) hash.update(chunk);
  const b = binding({ media: { kind: 'file', size: MEDIA_LIMITS.fileBytes }, sha256: hash.digest('hex') });
  const { mediaId } = spool.begin(b);
  for (let offset = 0; offset < MEDIA_LIMITS.fileBytes; offset += chunk.length) spool.write(1, mediaId, offset, chunk.toString('base64'));
  const source = spool.claim(b, { kind: 'file', mediaId });
  expect(source.read(MEDIA_LIMITS.fileBytes - chunk.length)).toEqual({ data: chunk.toString('base64'), eof: true });
  spool.release(1, mediaId);
});

it.skipIf(process.platform === 'win32')('recovers only a killed child spool and preserves a live child and unknown directories', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { spawn } = await import('node:child_process'); const { transpileModule, ModuleKind } = await import('typescript');
  const root = mkdtempSync(join(tmpdir(), 'qfca-crash-test-'));
  const source = readFileSync(join(process.cwd(), 'src/runtime/media-spool.ts'), 'utf8');
  writeFileSync(join(root, 'spool.cjs'), transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: 9 } }).outputText);
  const launch = () => {
    const child = spawn(process.execPath, ['-e', `const {MediaSpool}=require(${JSON.stringify(join(root, 'spool.cjs'))}); const s=new MediaSpool();s.begin({connectionEpoch:1,operationId:'op',conversation:{type:'private',peerId:'1'},media:{kind:'file',size:100},sha256:'0'.repeat(64)});process.stdout.write('ready');setInterval(()=>{},1000);`], { env: { ...process.env, TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    return child;
  };
  const alive = launch(); const killed = launch();
  const waitReady = (child: ReturnType<typeof launch>) => new Promise<void>((resolve, reject) => { child.stdout!.once('data', () => resolve()); child.once('error', reject); child.once('exit', (code) => reject(new Error(`Child exited early ${code}`))); });
  const terminate = async (child: ReturnType<typeof launch>) => { if (child.exitCode !== null || child.signalCode) return; const exited = new Promise<void>((resolve) => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited; };
  const original = process.env.TMPDIR;
  try {
    await Promise.all([waitReady(alive), waitReady(killed)]);
    const liveDir = readdirSync(root).find((name) => name.startsWith(`qfca-spool-v1-${alive.pid}-`))!;
    const deadDir = readdirSync(root).find((name) => name.startsWith(`qfca-spool-v1-${killed.pid}-`))!;
    mkdirSync(join(root, 'qfca-media-unknown')); writeFileSync(join(root, 'qfca-media-unknown', 'keep'), 'do not remove');
    await terminate(killed); process.env.TMPDIR = root;
    recoverStaleSpools();
    expect(existsSync(join(root, deadDir))).toBe(false);
    expect(existsSync(join(root, liveDir))).toBe(true);
    expect(readFileSync(join(root, 'qfca-media-unknown', 'keep'), 'utf8')).toBe('do not remove');
  } finally {
    await Promise.all([terminate(alive), terminate(killed)]);
    if (original === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = original;
    rmSync(root, { recursive: true, force: true });
  }
});

it('uses POSIX owner/mode checks without mistaking synthetic Windows bits for ACLs', () => {
  const stat = { isDirectory: () => true, isSymbolicLink: () => false, mode: 0o777, uid: 1 };
  expect(isPrivateSpoolDirectory(stat, 'linux', 1)).toBe(false);
  expect(isPrivateSpoolDirectory({ ...stat, mode: 0o700 }, 'linux', 1)).toBe(true);
  expect(isPrivateSpoolDirectory({ ...stat, mode: 0o700 }, 'linux', 2)).toBe(false);
  expect(isPrivateSpoolDirectory(stat, 'win32', undefined)).toBe(true);
  expect(isPrivateSpoolDirectory({ ...stat, isSymbolicLink: () => true }, 'win32', undefined)).toBe(false);
});
