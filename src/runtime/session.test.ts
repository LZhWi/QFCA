import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { QqOneBotSession, TEXT_CAPABILITIES, type QqSessionOptions } from "./session";
import { validateInboundMessage, type QqRuntimeConfig, type QqInboundMessageV1, type QqSendRequestV1 } from "../contract";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
type Action = { action: string; echo: string; params: Record<string, unknown> };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(response?: (action: Action, socket: WebSocket) => boolean, selfId = "10001", onInbound?: (message: QqInboundMessageV1) => Promise<void>, controls: Pick<QqSessionOptions, "sendBudgetMs" | "sendDelayMs" | "actionTimeoutMs" | "mediaTransfer"> = {}) {
  const inbound: QqInboundMessageV1[] = [];
  const config: QqRuntimeConfig = { configRevision: 3, listen: { host: "127.0.0.1", port: await freePort() },
    expectedSelfId: "10001", allowedPrivateUserIds: ["10002"], allowedGroupIds: ["20001"], groupRequireMention: true };
  const session = new QqOneBotSession({ config, accessToken: "test-secret", runtimeEpoch: 9, actionTimeoutMs: 80,
    sendDelayMs: 0, ...controls, onInbound: (message) => { inbound.push(message); return onInbound?.(message); } });
  cleanups.push(() => session.stop());
  await session.start();
  const actions: Action[] = [];
  const connect = async (account = selfId) => {
    const socket = new WebSocket(session.info!.url, { headers: { Authorization: "Bearer test-secret", "X-Self-ID": account } });
    cleanups.push(async () => { socket.terminate(); });
    socket.on("message", (raw) => {
      const action = JSON.parse(raw.toString()) as Action;
      actions.push(action);
      if (response?.(action, socket)) return;
      const data = action.action === "get_login_info" ? { user_id: account }
        : action.action === "get_group_member_info" ? { nickname: "朋友" }
        : action.action === "get_msg" ? { sender: { user_id: 10002 }, message: [{ type: "text", data: { text: "原消息" } }] }
        : { message_id: actions.length };
      socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: action.echo, data }));
    });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    return socket;
  };
  const socket = await connect();
  if (selfId === "10001") await vi.waitFor(() => expect(session.getStatus().phase).toBe("running"));
  const request = (parts: QqSendRequestV1["parts"] = [{ kind: "text", text: "你好" }]): QqSendRequestV1 => ({
    operationId: `op_${Math.random().toString(36).slice(2)}`, runtimeEpoch: 9, connectionEpoch: 1, selfId: "10001",
    conversation: { type: "private", peerId: "10002" }, parts,
  });
  const message = (overrides: Record<string, unknown> = {}) => ({ self_id: 10001, post_type: "message", message_type: "private",
    message_id: 5001, user_id: 10002, time: 1700000000, message: [{ type: "text", data: { text: "你好" } }], ...overrides });
  return { session, socket, config, inbound, actions, connect, request, message };
}

describe("QqOneBotSession", () => {
  it.each(["", " ", "\t", "\u00a0\u3000\ufeff"])("rejects blank credentials before any session side effects: %j", (accessToken) => {
    const inbound = vi.fn(); const status = vi.fn();
    expect(() => new QqOneBotSession({
      config: { configRevision: 0, listen: { host: "127.0.0.1", port: 3001 }, expectedSelfId: "10001",
        allowedPrivateUserIds: ["10002"], allowedGroupIds: [], groupRequireMention: true },
      accessToken, runtimeEpoch: 0, onInbound: inbound, onStatus: status,
    })).toThrow("nonempty Access Token");
    expect(inbound).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
  });
  it("does not bind before explicit start and only advertises implemented capabilities", async () => {
    const config = { configRevision: 0, listen: { host: "127.0.0.1", port: await freePort() }, expectedSelfId: "1",
      allowedPrivateUserIds: [], allowedGroupIds: [], groupRequireMention: true };
    const session = new QqOneBotSession({ config, accessToken: "test-secret", runtimeEpoch: 0, onInbound: () => undefined });
    expect(session.info).toBeNull();
    expect(TEXT_CAPABILITIES.messages.image).toBe(false);
    expect(TEXT_CAPABILITIES.backend.napcatStream).toBe(false);
    await session.stop();
  });
  it("normalizes, deduplicates and enforces the private/group whitelist", async () => {
    const f = await fixture();
    f.socket.send(JSON.stringify(f.message()));
    f.socket.send(JSON.stringify(f.message()));
    f.socket.send(JSON.stringify(f.message({ message_id: 5002, user_id: 99999 })));
    f.socket.send(JSON.stringify(f.message({ message_id: 5003, message_type: "group", group_id: 20001 })));
    f.socket.send(JSON.stringify(f.message({ message_id: 5004, message_type: "group", group_id: 20001,
      message: [{ type: "at", data: { qq: "10001" } }, { type: "text", data: { text: "群消息" } }] })));
    await vi.waitFor(() => expect(f.inbound).toHaveLength(2));
    expect(f.inbound.every(validateInboundMessage)).toBe(true);
    expect(f.inbound[1]).toMatchObject({ conversation: { type: "group", groupId: "20001" }, text: "群消息", configRevision: 3 });
    expect(f.inbound[0]).not.toHaveProperty("channel");
  });
  it("requires the confirmed account after reconnect and increments connection epoch", async () => {
    const f = await fixture();
    expect(f.session.getStatus()).toMatchObject({ connectionEpoch: 1 });
    const old = f.socket;
    const replacement = await f.connect();
    await vi.waitFor(() => expect(f.session.getStatus()).toMatchObject({ connectionEpoch: 2 }));
    expect((await f.session.send(f.request())).parts[0]).toMatchObject({ outcome: "failed", errorCode: "rejected" });
    expect(f.actions.filter((a) => a.action.startsWith("send_"))).toHaveLength(0);
    expect((await f.session.send({ ...f.request(), connectionEpoch: 2 })).outcome).toBe("sent");
    expect(old.readyState).not.toBe(WebSocket.OPEN);
    replacement.close();
    await vi.waitFor(() => expect(f.session.getStatus().phase).toBe("waiting-backend"));
    const other = await f.connect("99999");
    await vi.waitFor(() => expect(other.readyState).toBe(WebSocket.CLOSED));
    expect(f.session.getStatus().phase).toBe("waiting-backend");
  });
  it("sends only explicitly allowed targets and rejects old epochs and operation replays", async () => {
    const f = await fixture();
    const request = f.request();
    expect((await f.session.send(request)).outcome).toBe("sent");
    expect((await f.session.send(request)).outcome).toBe("failed");
    expect((await f.session.send({ ...f.request(), runtimeEpoch: 8 })).outcome).toBe("failed");
    expect((await f.session.send({ ...f.request(), conversation: { type: "private", peerId: "99999" } })).outcome).toBe("failed");
    expect(f.actions.filter((a) => a.action.startsWith("send_"))).toHaveLength(1);
  });
  it("keeps accepted sends possible while quiesced and does not accept new inbound", async () => {
    const f = await fixture();
    f.session.quiesce();
    f.socket.send(JSON.stringify(f.message()));
    expect((await f.session.send(f.request())).outcome).toBe("sent");
    expect(f.inbound).toHaveLength(0);
  });
  it("keeps reply and mention prefixes only on first group text chunk", async () => {
    const f = await fixture();
    const request = { ...f.request([{ kind: "text", text: "字".repeat(1800) }]), conversation: { type: "group" as const, groupId: "20001" },
      replyContext: { messageId: "70", mentionUserId: "10002" } };
    expect((await f.session.send(request)).outcome).toBe("sent");
    const sends = f.actions.filter((a) => a.action === "send_group_msg");
    expect(sends).toHaveLength(2);
    expect(sends[0].params.message).toMatchObject([{ type: "reply" }, { type: "at" }, { type: "text" }, { type: "text" }]);
    expect(sends[1].params.message).toMatchObject([{ type: "text" }]);
  });
  it("returns partial for unsupported media, without reading arbitrary media IDs", async () => {
    const f = await fixture();
    const result = await f.session.send(f.request([{ kind: "text", text: "text" }, { kind: "image", mediaId: "opaque_handle" }]));
    expect(result).toMatchObject({ outcome: "partial", parts: [{ outcome: "sent" }, { outcome: "failed", errorCode: "unsupported" }] });
    expect(f.actions.filter((a) => a.action.startsWith("send_"))).toHaveLength(1);
  });
  it("classifies explicit failure vs timeout and never retries automatically", async () => {
    let sends = 0;
    const f = await fixture((action, socket) => {
      if (!action.action.startsWith("send_")) return false;
      if (++sends === 1) socket.send(JSON.stringify({ status: "failed", retcode: 1, echo: action.echo, data: null, wording: "secret backend text" }));
      return true;
    });
    expect((await f.session.send(f.request())).parts[0]).toMatchObject({ outcome: "failed", errorCode: "rejected" });
    const unknown = await f.session.send(f.request());
    expect(unknown).toMatchObject({ outcome: "unknown", parts: [{ outcome: "unknown", errorCode: "timeout" }] });
    expect(JSON.stringify(unknown)).not.toContain("secret");
    expect(sends).toBe(2);
  });
  it("marks a partially delivered long text part unknown, not safely retryable failed", async () => {
    let sends = 0;
    const f = await fixture((action, socket) => {
      if (!action.action.startsWith("send_")) return false;
      if (++sends !== 2) return false;
      socket.send(JSON.stringify({ status: "failed", retcode: 1, echo: action.echo, data: null })); return true;
    });
    expect((await f.session.send(f.request([{ kind: "text", text: "字".repeat(1800) }]))).outcome).toBe("unknown");
    expect(sends).toBe(2);
  });
  it("invalidates an in-flight send on stop and releases the listener for restart", async () => {
    const f = await fixture((action) => action.action.startsWith("send_"));
    const pending = f.session.send(f.request());
    await vi.waitFor(() => expect(f.actions.some((a) => a.action.startsWith("send_"))).toBe(true));
    await f.session.stop();
    expect((await pending).outcome).toBe("unknown");
    expect(f.session.info).toBeNull();
    await Promise.all([f.session.start(), f.session.start()]);
    expect(f.session.info?.port).toBe(f.config.listen.port);
    await Promise.all([f.session.stop(), f.session.stop()]);
  });
  it("does not let an old host callback block the next listener generation", async () => {
    const f = await fixture(undefined, "10001", async (message) => {
      if (message.backendMessageId === "5001") await new Promise<void>(() => undefined);
    });
    f.socket.send(JSON.stringify(f.message()));
    await vi.waitFor(() => expect(f.inbound).toHaveLength(1));
    await f.session.stop();
    await f.session.start();
    const replacement = await f.connect();
    await vi.waitFor(() => expect(f.session.getStatus()).toMatchObject({ connectionEpoch: 2 }));
    replacement.send(JSON.stringify(f.message({ message_id: 5002 })));
    await vi.waitFor(() => expect(f.inbound).toHaveLength(2));
  });
  it("caps in-flight action timeout by the total send budget", async () => {
    const f = await fixture((action) => action.action.startsWith("send_"), "10001", undefined, { sendBudgetMs: 30, actionTimeoutMs: 1000 });
    const started = Date.now();
    expect((await f.session.send(f.request())).parts[0]).toMatchObject({ outcome: "unknown", errorCode: "timeout" });
    expect(Date.now() - started).toBeLessThan(500);
    expect(f.actions.filter((a) => a.action.startsWith("send_"))).toHaveLength(1);
  });
  it("stops further fragments after the whole operation budget is consumed", async () => {
    const f = await fixture(undefined, "10001", undefined, { sendBudgetMs: 30, sendDelayMs: 100 });
    expect((await f.session.send(f.request([{ kind: "text", text: "字".repeat(1800) }]))).parts[0]).toMatchObject({ outcome: "unknown", errorCode: "timeout" });
    expect(f.actions.filter((a) => a.action.startsWith("send_"))).toHaveLength(1);
  });
});

// Official NapCat stream shapes, with no QQ account or backend outside localhost.
function napcatFake(hook?: (action: Action, socket: WebSocket) => boolean) {
  const uploads = new Map<string, { hash: string; size: number; chunks: number; received: number }>();
  return (action: Action, socket: WebSocket): boolean => {
    if (hook?.(action, socket)) return true;
    const reply = (data: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo, data })); };
    if (action.action === 'get_version_info') reply({ app_name: 'NapCat.Onebot' });
    else if (action.action === 'can_send_image' || action.action === 'can_send_record') reply({ yes: true });
    else if (action.action === 'test_download_stream') {
      for (let i = 1; i <= 10; i++) reply({ type: 'stream', data_type: 'data_chunk', data: `Index-> ${i}` });
      reply({ type: 'response', data_type: 'data_complete', data: 'Stream transmission complete' });
    } else if (action.action === 'upload_file_stream') {
      const p = action.params; const id = String(p.stream_id);
      if (p.reset) { reply({ type: 'reset' }); return true; }
      if (p.is_complete) {
        const entry = uploads.get(id)!;
        reply({ type: 'response', status: 'file_complete', stream_id: id, file_size: entry.size, sha256: entry.hash, file_path: `/fake/backend/${id}.bin` });
      } else {
        const entry = uploads.get(id) ?? { hash: String(p.expected_sha256), size: Number(p.file_size), chunks: Number(p.total_chunks), received: 0 };
        entry.received++; uploads.set(id, entry);
        reply({ type: 'stream', status: 'chunk_received', stream_id: id, received_chunks: entry.received, total_chunks: entry.chunks });
      }
    } else if (action.action.startsWith('download_file_')) {
      const data = Buffer.from('download bytes');
      reply({ type: 'stream', data_type: 'file_info', file_name: 'media.png', file_size: data.length, chunk_size: 65536 });
      reply({ type: 'stream', data_type: 'file_chunk', index: 0, size: data.length, data: data.toString('base64') });
      reply({ type: 'response', data_type: 'file_complete', total_chunks: 1, total_bytes: data.length });
    } else return false;
    return true;
  };
}

async function mediaFixture(hook?: (action: Action, socket: WebSocket) => boolean) {
  const f = await fixture(napcatFake(hook), "10001", undefined, { mediaTransfer: "chunked-v1" });
  await vi.waitFor(() => expect(f.session.getCapabilities().backend.napcatStream).toBe(true));
  return f;
}

describe('NapCat media session', () => {
  it.each(["", " \t ", "\u00a0\u3000\ufeff"])("rejects unauthenticated media opt-in before probing or advertising: %j", (accessToken) => {
    const capabilities = vi.fn(); const status = vi.fn(); const inbound = vi.fn();
    expect(() => new QqOneBotSession({
      config: { configRevision: 0, listen: { host: "127.0.0.1", port: 3001 }, expectedSelfId: "10001",
        allowedPrivateUserIds: ["10002"], allowedGroupIds: [], groupRequireMention: true },
      accessToken, runtimeEpoch: 0, mediaTransfer: "chunked-v1", onInbound: inbound,
      onCapabilities: capabilities, onStatus: status,
    })).toThrow("nonempty Access Token");
    expect(capabilities).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled(); expect(inbound).not.toHaveBeenCalled();
  });
  it("keeps media on the authenticated backend when a tokenless peer tries to replace it", async () => {
    const { createHash } = await import('node:crypto'); const f = await mediaFixture();
    const originalStatus = f.session.getStatus();
    const received = vi.fn();
    const status = await new Promise<number>((resolve, reject) => {
      const impostor = new WebSocket(f.session.info!.url, { headers: { "X-Self-ID": "10001" } });
      impostor.on("message", received);
      impostor.on("open", () => { impostor.terminate(); reject(new Error("Unauthenticated media peer accepted")); });
      impostor.on("unexpected-response", (_request, response) => { resolve(response.statusCode!); response.resume(); impostor.terminate(); });
      impostor.on("error", () => undefined);
    });
    expect(status).toBe(401); expect(received).not.toHaveBeenCalled();
    expect(f.session.getStatus()).toEqual(originalStatus); expect(f.session.getCapabilities().messages.file).toBe(true);
    const bytes = Buffer.from("authenticated media only"); const request = f.request();
    const { mediaId } = f.session.mediaBeginUpload({ connectionEpoch: 1, operationId: request.operationId,
      conversation: request.conversation, media: { kind: "file", size: bytes.length }, sha256: createHash("sha256").update(bytes).digest("hex") });
    f.session.mediaWrite({ connectionEpoch: 1, mediaId, offset: 0, data: bytes.toString("base64") });
    expect((await f.session.send({ ...request, parts: [{ kind: "file", mediaId }] })).outcome).toBe("sent");
    expect(f.actions.some((action) => action.action === "upload_file_stream" && action.params.chunk_data === bytes.toString("base64"))).toBe(true);
    expect(received).not.toHaveBeenCalled();
  });

  it('releases every downloaded handle when normalized placeholders exceed the text limit', async () => {
    const f = await mediaFixture();
    // Keep one successful event alive to detect over-broad cleanup.
    f.socket.send(JSON.stringify(f.message({ message: [{ type: 'image', data: { file: 'kept' } }] })));
    await vi.waitFor(() => expect(f.inbound).toHaveLength(1));
    f.socket.send(JSON.stringify(f.message({ message_id: 5002, message: [
      { type: 'text', data: { text: 'x'.repeat(32768) } },
      { type: 'image', data: { file: 'first' } },
      { type: 'image', data: { file: 'second' } },
      { type: 'face', data: { id: '1' } },
    ] })));
    // Serial receive barrier proves the invalid event has finished.
    f.socket.send(JSON.stringify(f.message({ message_id: 5003 })));
    await vi.waitFor(() => expect(f.inbound).toHaveLength(2));
    expect(f.actions.filter((a) => a.action.startsWith('download_file_'))).toHaveLength(3);
    const kept = f.inbound[0];
    expect(f.session.mediaRead({ connectionEpoch: 1, eventId: kept.eventId, mediaId: kept.attachments![0].mediaId, offset: 0, limit: 65536 }).eof).toBe(true);
    const reservations = Array.from({ length: 255 }, (_, i) => f.session.mediaBeginUpload({
      connectionEpoch: 1, operationId: `cleanup_${i}`,
      conversation: { type: 'private', peerId: '10002' }, media: { kind: 'file', size: 1 }, sha256: '0'.repeat(64),
    }));
    for (const reservation of reservations) f.session.mediaRelease({ connectionEpoch: 1, ...reservation });
  });
  it('deduplicates media before downloading and preserves capacity for other transfers', async () => {
    const f = await mediaFixture();
    const message = f.message({ message: [{ type: 'image', data: { file: 'opaque-image' } }] });
    f.socket.send(JSON.stringify(message));
    // Queue duplicates while the first download can still be in flight; the
    // trailing text event is a barrier proving all duplicates were processed.
    for (let i = 0; i < 32; i++) f.socket.send(JSON.stringify(message));
    f.socket.send(JSON.stringify(f.message({ message_id: 5002 })));
    await vi.waitFor(() => expect(f.inbound).toHaveLength(2));
    expect(f.actions.filter((a) => a.action.startsWith('download_file_'))).toHaveLength(1);
    const first = f.inbound[0]; const mediaId = first.attachments![0].mediaId;
    expect(f.session.mediaRead({ connectionEpoch: 1, eventId: first.eventId, mediaId, offset: 0, limit: 65536 }).eof).toBe(true);
    // The host still owns its first handle; all other 255 slots remain free.
    const reservations = Array.from({ length: 255 }, (_, i) => f.session.mediaBeginUpload({ connectionEpoch: 1, operationId: `capacity_${i}`, conversation: { type: 'private', peerId: '10002' }, media: { kind: 'file', size: 1 }, sha256: '0'.repeat(64) }));
    for (const reservation of reservations) f.session.mediaRelease({ connectionEpoch: 1, ...reservation });
    f.socket.send(JSON.stringify({ ...message, message_id: 5003 }));
    await vi.waitFor(() => expect(f.inbound).toHaveLength(3));
    expect(f.inbound[2].attachments).toHaveLength(1);
    expect((await f.session.send(f.request())).outcome).toBe('sent');
  });
  it('does not let an invalid event reserve a media dedupe identity', async () => {
    const f = await mediaFixture();
    const message = f.message({ message: [{ type: 'image', data: { file: 'opaque-image' } }] });
    f.socket.send(JSON.stringify({ ...message, sender: { user_id: 99999 } }));
    f.socket.send(JSON.stringify(message));
    await vi.waitFor(() => expect(f.inbound).toHaveLength(1));
    expect(f.inbound[0].attachments).toHaveLength(1);
    expect(f.actions.filter((a) => a.action.startsWith('download_file_'))).toHaveLength(1);
  });
  it.each([
    [{ type: 'private', peerId: '10002' }, { peerId: '10002', type: 'private' }, 'send_private_msg'],
    [{ type: 'group', groupId: '20001' }, { groupId: '20001', type: 'group' }, 'send_group_msg'],
  ] as const)('sends media with reordered conversation fields (%j)', async (conversation, reordered, action) => {
    const { createHash } = await import('node:crypto'); const f = await mediaFixture();
    const bytes = Buffer.from('send bytes'); const req = { ...f.request(), conversation };
    const { mediaId } = f.session.mediaBeginUpload({ connectionEpoch: 1, operationId: req.operationId, conversation, media: { kind: 'file', size: bytes.length }, sha256: createHash('sha256').update(bytes).digest('hex') });
    f.session.mediaWrite({ connectionEpoch: 1, mediaId, offset: 0, data: bytes.toString('base64') });
    expect((await f.session.send({ ...req, conversation: reordered, parts: [{ kind: 'file', mediaId }] })).outcome).toBe('sent');
    expect(f.actions.filter((a) => a.action === action)).toHaveLength(1);
  });
  it('probes without sends, downloads bounded media handles, preserves text and never exposes paths', async () => {
    const f = await mediaFixture();
    expect(f.actions.filter((a) => a.action.startsWith('send_'))).toHaveLength(0);
    f.socket.send(JSON.stringify(f.message({ message: [{ type: 'text', data: { text: 'keep me' } }, { type: 'image', data: { file: 'opaque-id.image', url: 'http://private/' } }] })));
    await vi.waitFor(() => expect(f.inbound).toHaveLength(1));
    const msg = f.inbound[0]; expect(msg.text).toBe('keep me');
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments![0]).toMatchObject({ kind: 'image', filename: 'media.png', mime: 'image/png' });
    expect(JSON.stringify(msg)).not.toMatch(/fake\/backend|http:|opaque-id/);
    const mediaId = msg.attachments![0].mediaId;
    expect(f.session.mediaRead({ connectionEpoch: 1, eventId: msg.eventId, mediaId, offset: 0, limit: 65536 })).toEqual({ data: Buffer.from('download bytes').toString('base64'), eof: true });
    expect(() => f.session.mediaRead({ connectionEpoch: 1, eventId: 'other', mediaId, offset: 0, limit: 65536 })).toThrow();
    f.session.mediaRelease({ connectionEpoch: 1, mediaId });
  });
  it('uploads request-bound media and rejects replay, then clears handles on disconnect', async () => {
    const { createHash } = await import('node:crypto'); const f = await mediaFixture();
    const bytes = Buffer.from('send bytes'); const req = f.request();
    const uploaded = f.session.mediaBeginUpload({ connectionEpoch: 1, operationId: req.operationId, conversation: req.conversation, media: { kind: 'image', size: bytes.length }, sha256: createHash('sha256').update(bytes).digest('hex') });
    f.session.mediaWrite({ connectionEpoch: 1, mediaId: uploaded.mediaId, offset: 0, data: bytes.toString('base64') });
    req.parts = [{ kind: 'image', mediaId: uploaded.mediaId }];
    expect((await f.session.send(req)).outcome).toBe('sent');
    expect((await f.session.send(req)).outcome).toBe('failed');
    const send = f.actions.find((a) => a.action === 'send_private_msg')!;
    expect(JSON.stringify(send.params)).toContain('/fake/backend/');
    expect(JSON.stringify(send.params)).not.toContain(uploaded.mediaId);
    const next = f.request(); const pending = f.session.mediaBeginUpload({ connectionEpoch: 1, operationId: next.operationId, conversation: next.conversation, media: { kind: 'file', size: bytes.length }, sha256: createHash('sha256').update(bytes).digest('hex') });
    f.socket.close(); await vi.waitFor(() => expect(f.session.getStatus().phase).toBe('waiting-backend'));
    expect(() => f.session.mediaWrite({ connectionEpoch: 1, mediaId: pending.mediaId, offset: 0, data: bytes.toString('base64') })).toThrow();
  });
  it('does not download path/URL input and retains safe text with a placeholder', async () => {
    const f = await mediaFixture();
    const bad = ['file:///etc/passwd', '/tmp/file', '../secret', './file', 'https://example.com', 'C:\\secret'];
    f.socket.send(JSON.stringify(f.message({ message: [{ type: 'text', data: { text: 'safe' } }, ...bad.map((file) => ({ type: 'image', data: { file } }))] })));
    await vi.waitFor(() => expect(f.inbound).toHaveLength(1));
    expect(f.inbound[0].text).toBe('safe' + '[附件不可用:image]'.repeat(bad.length));
    expect(f.actions.filter((a) => a.action.startsWith('download_file'))).toHaveLength(0);
  });
  it('failed stream probe cannot advertise media or emit media sends', async () => {
    const f = await fixture(napcatFake((action, socket) => {
      if (action.action !== 'test_download_stream') return false;
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo, data: { type: 'response', data_type: 'data_complete' } })); return true;
    }), '10001', undefined, { mediaTransfer: 'chunked-v1' });
    expect((await f.session.send(f.request([{ kind: 'image', mediaId: 'fake' }]))).parts[0]).toMatchObject({ outcome: 'failed', errorCode: 'unsupported' });
    expect(f.actions.some((a) => a.action === 'upload_file_stream')).toBe(false);
  });
  it('disconnect during backend upload cannot dispatch a send on either connection', async () => {
    const { createHash } = await import('node:crypto'); let uploads = 0;
    const f = await mediaFixture((action, socket) => {
      if (action.action === 'upload_file_stream' && action.params.chunk_data && ++uploads === 2) { socket.close(); return true; } return false;
    });
    const req = f.request(); const data = Buffer.from('outbound');
    const { mediaId } = f.session.mediaBeginUpload({ connectionEpoch: 1, operationId: req.operationId, conversation: req.conversation, media: { kind: 'file', size: data.length }, sha256: createHash('sha256').update(data).digest('hex') });
    f.session.mediaWrite({ connectionEpoch: 1, mediaId, offset: 0, data: data.toString('base64') });
    expect((await f.session.send({ ...req, parts: [{ kind: 'file', mediaId }] })).outcome).toBe('failed');
    expect(f.actions.filter((a) => a.action.startsWith('send_'))).toHaveLength(0);
  });
});

it('host rejection releases all current media and preserves earlier delivery', async () => {
 const f = await fixture(napcatFake(), '10001', async m => { if(m.backendMessageId === '5002') throw new Error('host reject'); }, {mediaTransfer:'chunked-v1'});
 await vi.waitFor(() => expect(f.session.getCapabilities().backend.napcatStream).toBe(true));
 for (const id of [5001, 5002]) f.socket.send(JSON.stringify(f.message({message_id:id,message:[{type:'image',data:{file:'a'}},{type:'image',data:{file:'b'}}]})));
 f.socket.send(JSON.stringify(f.message({message_id:5003})));
 await vi.waitFor(() => expect(f.inbound).toHaveLength(3));
 for (const a of f.inbound[0].attachments!) expect(f.session.mediaRead({connectionEpoch:1,mediaId:a.mediaId,eventId:f.inbound[0].eventId,offset:0,limit:65536}).eof).toBe(true);
 for (const a of f.inbound[1].attachments!) expect(() => f.session.mediaRead({connectionEpoch:1,mediaId:a.mediaId,eventId:f.inbound[1].eventId,offset:0,limit:65536})).toThrow();
 const reserved = Array.from({length:254},(_,i) => f.session.mediaBeginUpload({connectionEpoch:1,operationId:`qa_${i}`,conversation:{type:'private',peerId:'10002'},media:{kind:'file',size:1},sha256:'0'.repeat(64)}));
 for(const r of reserved) f.session.mediaRelease({connectionEpoch:1,...r});
});
it('quiesce during second download releases earlier and partial handles', async () => {
 let quiesce: (()=>void)|undefined;
 let downloads = 0;
 const f = await mediaFixture((a) => {if(a.action.startsWith('download_file_') && ++downloads === 2) quiesce!(); return false;});
 quiesce = () => f.session.quiesce();
 f.socket.send(JSON.stringify(f.message({message:[{type:'image',data:{file:'a'}},{type:'image',data:{file:'b'}}]})));
 await vi.waitFor(() => expect(downloads).toBe(2));
 await (f.session as any).receiveChain;
 expect(f.inbound).toHaveLength(0);
 const reserved = Array.from({length:256},(_,i) => f.session.mediaBeginUpload({connectionEpoch:1,operationId:`qa_${i}`,conversation:{type:'private',peerId:'10002'},media:{kind:'file',size:1},sha256:'0'.repeat(64)}));
 for(const r of reserved) f.session.mediaRelease({connectionEpoch:1,...r});
});
