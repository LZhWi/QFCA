import { createHash, randomUUID } from 'node:crypto';
import type { QqCapabilitySnapshot, QqMedia } from '../contract';
import { MEDIA_LIMITS, MediaSpool, decodeChunk } from '../runtime/media-spool';
import type { OneBotActionClient } from './onebot-action-client';
import type { OneBotSegment, OneBotStreamPacket } from './onebot-types';

export function opaqueBackendFileId(value: unknown): value is string {
  // A bare opaque token only. No URL, separators, dotted relative paths or schemes.
  return typeof value === 'string' && value.length <= 256 && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value);
}
const timeout = (deadline: number) => { const left = Math.floor(deadline - performance.now()); if (left < 1) throw new Error('Media timeout'); return Math.min(left, 30_000); };
/** Upload only bytes from our spool; backend-returned paths never cross IPC. */
export async function uploadMedia(client: OneBotActionClient, source: { size: number; read(offset: number): { data: string; eof: boolean } }, check: () => void, deadline: number, extension = 'bin'): Promise<string> {
  const streamId = randomUUID();
  const totalChunks = Math.ceil(source.size / MEDIA_LIMITS.chunkBytes);
  const hash = createHash('sha256');
  for (let offset = 0; offset < source.size; offset += MEDIA_LIMITS.chunkBytes) hash.update(decodeChunk(source.read(offset).data));
  const sha256 = hash.digest('hex');
  let completed = false;
  try {
    for (let index = 0, offset = 0; offset < source.size; index++, offset += MEDIA_LIMITS.chunkBytes) {
      check();
      const result = await client.call<OneBotStreamPacket>('upload_file_stream', {
        stream_id: streamId, chunk_data: source.read(offset).data, chunk_index: index,
        total_chunks: totalChunks, file_size: source.size, expected_sha256: sha256,
        filename: `qfca_${streamId}.${extension}`, file_retention: MEDIA_LIMITS.ttlMs,
      }, timeout(deadline));
      check();
      if (result?.type !== 'stream' || result.status !== 'chunk_received' || result.stream_id !== streamId || result.received_chunks !== index + 1 || result.total_chunks !== totalChunks) throw new Error('Invalid upload response');
    }
    check();
    const result = await client.call<OneBotStreamPacket>('upload_file_stream', { stream_id: streamId, is_complete: true, file_retention: MEDIA_LIMITS.ttlMs }, timeout(deadline));
    check();
    if (result?.type !== 'response' || result.status !== 'file_complete' || result.stream_id !== streamId || result.file_size !== source.size || result.sha256 !== sha256 || typeof result.file_path !== 'string' || !result.file_path.length || result.file_path.length > 4096 || /[\0\r\n]/.test(result.file_path)) throw new Error('Invalid upload completion');
    completed = true;
    return result.file_path;
  } finally {
    if (!completed) { try { check(); void client.call('upload_file_stream', { stream_id: streamId, reset: true, file_retention: MEDIA_LIMITS.ttlMs }, 1000).catch(() => undefined); } catch { /* Old connection: backend owns expiry. */ } }
  }
}
export async function probeMedia(client: OneBotActionClient, base: QqCapabilitySnapshot, check: () => void): Promise<QqCapabilitySnapshot> {
  const result = structuredClone(base);
  const deadline = performance.now() + 10_000;
  try {
    const version = await client.call<{ app_name?: string }>('get_version_info', {}, timeout(deadline)); check();
    if (version?.app_name !== 'NapCat.Onebot') return result;
    const image = await client.call<{ yes?: boolean }>('can_send_image', {}, timeout(deadline)); check();
    const audio = await client.call<{ yes?: boolean }>('can_send_record', {}, timeout(deadline)); check();
    let packets = 0;
    const completion = await client.callStream<OneBotStreamPacket>('test_download_stream', { error: false }, (packet) => {
      check();
      if (packet.type === 'response') return;
      if (packet.type !== 'stream' || packet.data_type !== 'data_chunk' || packet.data !== `Index-> ${++packets}` || packets > 10) throw new Error('Invalid stream probe');
    }, timeout(deadline)); check();
    if (packets !== 10 || completion.type !== 'response' || completion.data_type !== 'data_complete' || completion.data !== 'Stream transmission complete') return result;
    const data = Buffer.from('QFCA media probe');
    await uploadMedia(client, { size: data.length, read: () => ({ data: data.toString('base64'), eof: true }) }, check, deadline); check();
    result.backend.napcatStream = true;
    Object.assign(result.messages, { image: image?.yes === true, sticker: false, audio: audio?.yes === true, file: true, video: true, maxFileBytes: MEDIA_LIMITS.fileBytes });
  } catch { /* Unsupported/failed probes safely retain text only. */ }
  return result;
}
export async function downloadMedia(client: OneBotActionClient, spool: MediaSpool, epoch: number, eventId: string, segment: OneBotSegment, check: () => void): Promise<QqMedia> {
  const fileId = segment.data.file_id ?? segment.data.file;
  if (!opaqueBackendFileId(fileId)) throw new Error('Invalid backend media ID');
  const kind = ({ image: 'image', mface: 'image', record: 'audio', file: 'file', video: 'video' } as Record<string, QqMedia['kind']>)[segment.type];
  if (!kind) throw new Error('Unsupported media');
  let media: QqMedia | undefined; let offset = 0; let index = 0;
  try {
    const action = kind === 'image' ? 'download_file_image_stream' : kind === 'audio' ? 'download_file_record_stream' : 'download_file_stream';
    const terminal = await client.callStream<OneBotStreamPacket>(action, { file_id: fileId, chunk_size: MEDIA_LIMITS.chunkBytes, ...(kind === 'audio' ? { out_format: 'mp3' } : {}) }, (packet) => {
      check();
      if (packet.type === 'stream' && packet.data_type === 'file_info') {
        if (media || packet.chunk_size !== MEDIA_LIMITS.chunkBytes || !Number.isSafeInteger(packet.file_size) || packet.file_size! < 1 || packet.file_size! > MEDIA_LIMITS.fileBytes) throw new Error('Invalid media info');
        const filename = safeFilename(packet.file_name);
        const mime = kind === 'audio' ? 'audio/mpeg' : mediaMime(filename);
        media = spool.beginInbound(epoch, eventId, { kind, size: kind === 'audio' ? MEDIA_LIMITS.fileBytes : packet.file_size!, ...(filename ? { filename } : {}), ...(mime ? { mime } : {}) });
      } else if (packet.type === 'stream' && packet.data_type === 'file_chunk') {
        if (!media || packet.index !== index || packet.size !== decodeChunk(packet.data).length) throw new Error('Invalid media chunk');
        spool.write(epoch, media.mediaId, offset, packet.data!, true); offset += packet.size; index++;
      } else if (packet.type !== 'response') throw new Error('Invalid media stream');
    }, 120_000);
    check();
    if (!media || terminal.type !== 'response' || terminal.data_type !== 'file_complete' || terminal.total_bytes !== offset || terminal.total_chunks !== index || (kind !== 'audio' && offset !== media.size)) throw new Error('Incomplete media stream');
    return spool.finishInbound(epoch, media.mediaId, offset, terminal.sha256);
  } catch { if (media) { try { spool.release(epoch, media.mediaId); } catch { /* revoked */ } } throw new Error('Media unavailable'); }
}

export function safeFilename(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\\/:\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..' ? value : undefined;
}
function mediaMime(filename?: string): string | undefined {
  const ext = filename?.split('.').pop()?.toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', pdf: 'application/pdf', txt: 'text/plain' } as Record<string,string>)[ext ?? ''];
}
