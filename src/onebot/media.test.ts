import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadMedia, opaqueBackendFileId, safeFilename } from './media';
import type { OneBotActionClient } from './onebot-action-client';
import type { OneBotStreamPacket } from './onebot-types';
import { MediaSpool, MEDIA_LIMITS } from '../runtime/media-spool';
const spools: MediaSpool[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const s of spools.splice(0)) s.dispose(); });
function fake(packets: OneBotStreamPacket[]) {
  return { callStream: async (_a: string, _p: unknown, cb: (packet: OneBotStreamPacket) => void) => { for (const p of packets) cb(p); return packets.at(-1); } } as unknown as OneBotActionClient;
}
const data = Buffer.from('transcoded mp3 bytes');
function packets(infoSize: number): OneBotStreamPacket[] { return [
  { type: 'stream', data_type: 'file_info', file_name: 'voice.silk', file_size: infoSize, chunk_size: 65536 },
  { type: 'stream', data_type: 'file_chunk', index: 0, data: data.toString('base64'), size: data.length },
  { type: 'response', data_type: 'file_complete', total_chunks: 1, total_bytes: data.length },
]; }
describe('NapCat download boundary', () => {
  it.each(['file_chunk', 'file_complete'])('checks the shared deadline before accepting a late %s and releases the partial handle', async (late) => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const spool = new MediaSpool(); spools.push(spool);
    const release = vi.spyOn(spool, 'release');
    const callStream = vi.fn(async (_action, _params, callback, timeoutMs) => {
      expect(timeoutMs).toBe(25);
      const stream = packets(data.length);
      callback(stream[0]);
      if (late === 'file_complete') callback(stream[1]);
      clock = 25;
      if (late === 'file_chunk') callback(stream[1]);
      return stream[2];
    });
    await expect(downloadMedia({ callStream } as unknown as OneBotActionClient, spool, 1, 'event',
      { type: 'image', data: { file: 'opaque' } }, () => undefined, 25)).rejects.toThrow('Media unavailable');
    expect(callStream).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(() => spool.read(1, release.mock.calls[0][1], 'event', 0, 65536)).toThrow();
  });
  it('does not start a request once the shared deadline has expired', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(100);
    const spool = new MediaSpool(); spools.push(spool);
    const callStream = vi.fn();
    await expect(downloadMedia({ callStream } as unknown as OneBotActionClient, spool, 1, 'event',
      { type: 'file', data: { file: 'opaque' } }, () => undefined, 100)).rejects.toThrow('Media unavailable');
    expect(callStream).not.toHaveBeenCalled();
  });
  it.each([1, 999])('uses actual bounded converted audio size instead of original silk size %s', async (size) => {
    const spool = new MediaSpool(); spools.push(spool);
    const media = await downloadMedia(fake(packets(size)), spool, 1, 'event', { type: 'record', data: { file: 'id.silk' } }, () => undefined);
    expect(media).toMatchObject({ kind: 'audio', size: data.length, mime: 'audio/mpeg' });
    expect(spool.read(1, media.mediaId, 'event', 0, 65536).data).toBe(data.toString('base64'));
  });
  it.each(['image', 'file', 'video'])('keeps strict declared size for %s', async (type) => {
    const spool = new MediaSpool(); spools.push(spool);
    await expect(downloadMedia(fake(packets(1)), spool, 1, 'event', { type, data: { file: 'id' } }, () => undefined)).rejects.toThrow();
  });
  it('rejects oversized info, malformed order, terminal hash mismatch, and wrong sequence', async () => {
    for (const input of [packets(MEDIA_LIMITS.fileBytes + 1), packets(0), packets(data.length).slice(1), packets(data.length).map((p) => p.data_type === 'file_chunk' ? { ...p, index: 1 } : p), packets(data.length).map((p) => p.type === 'response' ? { ...p, sha256: '0'.repeat(64) } : p)]) {
      const spool = new MediaSpool(); spools.push(spool);
      await expect(downloadMedia(fake(input), spool, 1, 'event', { type: 'record', data: { file: 'id' } }, () => undefined)).rejects.toThrow();
    }
  });
  it('allows event opaque tokens with extensions but never paths or URLs', () => {
    expect(opaqueBackendFileId('abc123.image')).toBe(true);
    for (const value of ['./abc', '../a', '/a', 'file:///a', 'https://a', 'C:\\a', '..', '.a', 'a..b']) expect(opaqueBackendFileId(value)).toBe(false);
    expect(safeFilename('../secret')).toBeUndefined(); expect(safeFilename('photo.png')).toBe('photo.png');
  });
});
