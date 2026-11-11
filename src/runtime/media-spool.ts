import { createHash, randomUUID, type Hash } from 'node:crypto';
import { mkdtempSync, openSync, closeSync, writeSync, readSync, unlinkSync, rmdirSync, readdirSync, lstatSync, readFileSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import type { QqConversation, QqMedia } from '../contract';

const SPOOL_PREFIX = 'qfca-spool-v1-';
const OWNER_MARKER = '.qfca-owner';
export function isPrivateSpoolDirectory(stat: Pick<Stats, 'isDirectory' | 'isSymbolicLink' | 'mode' | 'uid'>, platform: NodeJS.Platform = process.platform, uid: number | undefined = process.getuid?.()): boolean {
  // Windows/libuv stat synthesizes 0444/0666 bits, not ACL ownership. On Windows
  // keep the platform-selected temp root, marker, no-link and dead-PID checks;
  // do not pretend POSIX mode bits validate that user's ACL.
  return stat.isDirectory() && !stat.isSymbolicLink()
    && (platform === 'win32' || (!(stat.mode & 0o077) && (uid === undefined || stat.uid === uid)));
}
/** Only our private, marked directories belonging to a definitely dead PID.
 * Never recurse, follow links, guess ownership or remove another live instance. */
export function recoverStaleSpools(): void {
  const root = tmpdir();
  for (const name of readdirSync(root)) {
    const match = /^qfca-spool-v1-([1-9][0-9]*)-[A-Za-z0-9]{6}$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
    const path = join(root, name);
    let owned = false;
    try {
      const dir = lstatSync(path); const marker = lstatSync(join(path, OWNER_MARKER));
      if (!isPrivateSpoolDirectory(dir)
        || !marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1 || marker.uid !== dir.uid || marker.size > 128) continue;
      owned = readFileSync(join(path, OWNER_MARKER), 'utf8') === `qfca-media-v1:${name}`;
    } catch { continue; }
    if (!owned) continue;
    try { process.kill(pid, 0); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
    // Recognized dead spool failures fail closed, rather than silently allowing
    // a new 512MiB budget while previous owned data remains on disk.
    try {
      const names = readdirSync(path);
      for (const file of names) {
        if (file !== OWNER_MARKER && !/^media_[a-f0-9]{32}$/.test(file)) throw new Error('Unknown spool entry');
        const stat = lstatSync(join(path, file));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe spool entry');
      }
      for (const file of names.filter((file) => file !== OWNER_MARKER)) unlinkSync(join(path, file));
      unlinkSync(join(path, OWNER_MARKER)); rmdirSync(path);
    } catch { throw new Error('Stale media cleanup unavailable'); }
  }
}

export const MEDIA_LIMITS = { fileBytes: 100 * 1024 * 1024, chunkBytes: 64 * 1024, totalBytes: 512 * 1024 * 1024, ttlMs: 300_000, handles: 256 } as const;
export interface UploadBinding { connectionEpoch: number; operationId: string; conversation: QqConversation; media: Omit<QqMedia, 'mediaId'> & { size: number }; sha256: string }
interface Entry { fd: number; path: string; expires: number; epoch: number; media: QqMedia; size: number; offset: number; readOffset: number; hash: Hash; expectedHash?: string; digest?: string; sealed: boolean; claimed: boolean; operationId?: string; conversation?: string; eventId?: string }
function conversationKey(conversation: QqConversation): string {
  return JSON.stringify([conversation.type, conversation.type === 'private' ? conversation.peerId : conversation.groupId]);
}
export function decodeChunk(data: unknown): Buffer {
  if (typeof data !== 'string' || data.length > Math.ceil(MEDIA_LIMITS.chunkBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('Invalid media chunk');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MEDIA_LIMITS.chunkBytes || bytes.toString('base64') !== data) throw new Error('Invalid media chunk');
  return bytes;
}
/** Private ephemeral spool. No caller can choose a filesystem path. Synchronous bounded
 * chunks make revocation atomic with writes; no late async write can recreate a file. */
export class MediaSpool {
  private entries = new Map<string, Entry>();
  private directory?: string;
  private reserved = 0;
  private timer?: NodeJS.Timeout;
  constructor(private readonly now = Date.now) {}
  private allocate(epoch: number, media: Omit<QqMedia, 'mediaId'> & { size: number }): [string, Entry] {
    this.sweep();
    if (!Number.isSafeInteger(media.size) || media.size < 1 || media.size > MEDIA_LIMITS.fileBytes || this.reserved + media.size > MEDIA_LIMITS.totalBytes || this.entries.size >= MEDIA_LIMITS.handles) throw new Error('Media capacity exceeded');
    if (!this.directory) {
      recoverStaleSpools();
      const directory = mkdtempSync(join(tmpdir(), `${SPOOL_PREFIX}${process.pid}-`));
      try { writeFileSync(join(directory, OWNER_MARKER), `qfca-media-v1:${basename(directory)}`, { flag: 'wx', mode: 0o600 }); }
      catch { try { rmdirSync(directory); } catch { /* No media bytes were allocated. */ } throw new Error('Media spool unavailable'); }
      this.directory = directory;
    }
    this.timer ??= setInterval(() => this.sweep(), 1000); this.timer.unref();
    const mediaId = `media_${randomUUID().replace(/-/g, '')}`;
    const path = join(this.directory, mediaId);
    const fd = openSync(path, 'wx+', 0o600);
    const entry: Entry = { fd, path, epoch, media: { ...media, mediaId }, size: media.size, offset: 0, readOffset: 0, hash: createHash('sha256'), sealed: false, claimed: false, expires: this.now() + MEDIA_LIMITS.ttlMs };
    this.entries.set(mediaId, entry); this.reserved += media.size;
    return [mediaId, entry];
  }
  begin(binding: UploadBinding): { mediaId: string } {
    if (!/^[a-f0-9]{64}$/.test(binding.sha256)) throw new Error('Invalid media hash');
    const [mediaId, entry] = this.allocate(binding.connectionEpoch, binding.media);
    entry.operationId = binding.operationId; entry.conversation = conversationKey(binding.conversation); entry.expectedHash = binding.sha256;
    return { mediaId };
  }
  beginInbound(epoch: number, eventId: string, media: Omit<QqMedia, 'mediaId'> & { size: number }): QqMedia {
    const [, entry] = this.allocate(epoch, media); entry.eventId = eventId; return { ...entry.media };
  }
  private get(mediaId: string, epoch: number): Entry {
    this.sweep(); const entry = this.entries.get(mediaId);
    if (!entry || entry.fd < 0 || entry.epoch !== epoch) throw new Error('Invalid media handle'); return entry;
  }
  write(epoch: number, mediaId: string, offset: number, data: string, inbound = false): void {
    const entry = this.get(mediaId, epoch);
    try {
      if (entry.sealed || entry.claimed || !!entry.eventId !== inbound || offset !== entry.offset) throw new Error('Invalid media offset');
      const bytes = decodeChunk(data);
      if (offset + bytes.length > entry.size) throw new Error('Invalid media size');
      if (writeSync(entry.fd, bytes, 0, bytes.length, offset) !== bytes.length) throw new Error('Media write failed');
      entry.hash.update(bytes); entry.offset += bytes.length;
      if (entry.offset === entry.size) {
        const hash = entry.hash.digest('hex'); entry.digest = hash;
        if (entry.expectedHash && hash !== entry.expectedHash) throw new Error('Media integrity mismatch');
        entry.sealed = true;
      }
    } catch { this.remove(mediaId); throw new Error('Invalid media transfer'); }
  }
  finishInbound(epoch: number, mediaId: string, actualSize: number, expectedHash?: string): QqMedia {
    const entry = this.get(mediaId, epoch);
    if (!entry.eventId || actualSize < 1 || actualSize !== entry.offset || actualSize > entry.size) throw new Error('Invalid media completion');
    entry.digest ??= entry.hash.digest('hex');
    if (expectedHash !== undefined && (!/^[a-f0-9]{64}$/.test(expectedHash) || expectedHash !== entry.digest)) throw new Error('Invalid media integrity');
    this.reserved -= entry.size - actualSize;
    entry.size = actualSize; entry.media.size = actualSize; entry.sealed = true;
    return { ...entry.media };
  }
  read(epoch: number, mediaId: string, eventId: string, offset: number, limit: number): { data: string; eof: boolean } {
    const entry = this.get(mediaId, epoch);
    if (!entry.sealed || entry.eventId !== eventId) throw new Error('Invalid media binding');
    if (offset !== entry.readOffset) throw new Error('Invalid media read offset');
    const result = this.readEntry(entry, offset, limit);
    entry.readOffset += Buffer.from(result.data, 'base64').length;
    return result;
  }
  private readEntry(entry: Entry, offset: number, limit: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= entry.size || !Number.isSafeInteger(limit) || limit < 1 || limit > MEDIA_LIMITS.chunkBytes) throw new Error('Invalid media range');
    const bytes = Buffer.alloc(Math.min(limit, entry.size - offset));
    const length = readSync(entry.fd, bytes, 0, bytes.length, offset);
    if (length !== bytes.length) throw new Error('Media read failed');
    return { data: bytes.toString('base64'), eof: offset + length === entry.size };
  }
  claim(binding: { connectionEpoch: number; operationId: string; conversation: QqConversation }, media: QqMedia): { size: number; read: (offset: number) => { data: string; eof: boolean } } {
    const entry = this.get(media.mediaId, binding.connectionEpoch);
    if (!entry.sealed || entry.claimed || entry.eventId || entry.operationId !== binding.operationId || entry.conversation !== conversationKey(binding.conversation) || entry.media.kind !== media.kind || (media.size !== undefined && media.size !== entry.size)) throw new Error('Invalid media binding');
    for (const key of ['filename', 'mime', 'caption'] as const) if (media[key] !== undefined && media[key] !== entry.media[key]) throw new Error('Invalid media metadata');
    entry.claimed = true;
    return { size: entry.size, read: (offset) => this.readEntry(this.get(media.mediaId, binding.connectionEpoch), offset, MEDIA_LIMITS.chunkBytes) };
  }
  release(epoch: number, mediaId: string): void { this.get(mediaId, epoch); this.remove(mediaId); }
  private remove(id: string): void {
    const entry = this.entries.get(id); if (!entry) return;
    if (entry.fd >= 0) { try { closeSync(entry.fd); } catch { /* Cleanup must never crash a timer or disconnect. */ } entry.fd = -1; }
    try { unlinkSync(entry.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { entry.expires = 0; return; } }
    this.entries.delete(id); this.reserved -= entry.size;
  }
  sweep(): void { for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.remove(id); }
  revoke(): void { clearInterval(this.timer); this.timer = undefined; for (const id of this.entries.keys()) this.remove(id); if (this.directory && this.entries.size === 0) { try { try { unlinkSync(join(this.directory, OWNER_MARKER)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } rmdirSync(this.directory); this.directory = undefined; } catch { /* Retry next revoke; never touch another directory. */ } } if (this.entries.size) { this.timer = setInterval(() => this.sweep(), 1000); this.timer.unref(); } }
  dispose(): void { this.revoke(); }
}
