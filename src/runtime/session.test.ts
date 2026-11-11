import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { QqOneBotSession, TEXT_CAPABILITIES, type QqSessionOptions } from "./session";
import { validateInboundMessage, type QqRuntimeConfig, type QqInboundMessageV1, type QqSendRequestV1, type QqMedia } from "../contract";

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
async function fixture(response?: (action: Action, socket: WebSocket) => boolean, selfId = "10001", onInbound?: (message: QqInboundMessageV1) => Promise<void>, controls: Pick<QqSessionOptions, "sendBudgetMs" | "sendDelayMs" | "actionTimeoutMs" | "mediaTransfer" | "normalizationBudgetMs"> = {}) {
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

async function mediaFixture(hook?: (action: Action, socket: WebSocket) => boolean, controls: Pick<QqSessionOptions, "normalizationBudgetMs" | "actionTimeoutMs" | "sendBudgetMs" | "sendDelayMs"> = {}) {
  const f = await fixture(napcatFake(hook), "10001", undefined, { mediaTransfer: "chunked-v1", ...controls });
  await vi.waitFor(() => expect(f.session.getCapabilities().backend.napcatStream).toBe(true));
  return f;
}

function uploadPart(f: Awaited<ReturnType<typeof mediaFixture>>, request: QqSendRequestV1, metadata: Omit<QqMedia, "mediaId">): QqMedia {
  const bytes = Buffer.from("isolated caption fixture");
  const media = { ...metadata, size: bytes.length };
  const { mediaId } = f.session.mediaBeginUpload({ connectionEpoch: request.connectionEpoch, operationId: request.operationId,
    conversation: request.conversation, media, sha256: createHash("sha256").update(bytes).digest("hex") });
  f.session.mediaWrite({ connectionEpoch: request.connectionEpoch, mediaId, offset: 0, data: bytes.toString("base64") });
  return { ...media, mediaId };
}

describe('NapCat media session', () => {
  it.each(["image", "audio", "file", "video"] as const)("delivers %s caption as bounded text after the attachment and acknowledges both", async (kind) => {
    const f = await mediaFixture(); const request = f.request();
    request.parts = [uploadPart(f, request, { kind, caption: "媒体说明 🌸" })];
    const result = await f.session.send(request);
    const sends = f.actions.filter((a) => a.action === "send_private_msg");
    expect(sends).toHaveLength(2);
    expect(sends[0].params.message).toMatchObject([{ type: kind === "audio" ? "record" : kind }]);
    expect(sends[1].params.message).toEqual([{ type: "text", data: { text: "媒体说明 🌸" } }]);
    expect(result).toEqual({ operationId: request.operationId, outcome: "sent", parts: [
      { partIndex: 0, outcome: "sent", messageId: String(f.actions.indexOf(sends[1]) + 1) },
    ] });
  });

  it.each([undefined, "", " \n\t "])("does not add a text send for an absent/blank caption: %j", async (caption) => {
    const f = await mediaFixture(); const request = f.request();
    request.parts = [uploadPart(f, request, { kind: "image", ...(caption !== undefined ? { caption } : {}) })];
    expect((await f.session.send(request)).outcome).toBe("sent");
    expect(f.actions.filter((a) => a.action.startsWith("send_"))).toHaveLength(1);
  });
  it.each([false, true])("preserves mixed text/media order, Unicode caption chunks and one group reply (leading text: %s)", async (leadingText) => {
    const f = await mediaFixture(); const request = { ...f.request(), conversation: { type: "group" as const, groupId: "20001" },
      replyContext: { messageId: "70", mentionUserId: "10002" } };
    const first = uploadPart(f, request, { kind: "image", caption: "🌸".repeat(1501) });
    const second = uploadPart(f, request, { kind: "file", caption: "第二个说明", filename: "fixture.txt" });
    request.parts = [...(leadingText ? [{ kind: "text" as const, text: "before" }] : []), first, { kind: "text", text: "between" }, second, { kind: "text", text: "after" }];
    const result = await f.session.send(request);
    expect(result.outcome).toBe("sent"); expect(result.parts).toHaveLength(request.parts.length);
    const sends = f.actions.filter((a) => a.action === "send_group_msg");
    const messages = sends.map((a) => a.params.message as { type: string; data: Record<string, unknown> }[]);
    expect(messages[0].slice(0, 3)).toEqual([{ type: "reply", data: { id: "70" } }, { type: "at", data: { qq: "10002" } }, { type: "text", data: { text: " " } }]);
    const bodies = messages.map((segments, index) => index ? segments : segments.slice(3));
    expect(bodies.map((segments) => segments[0].type)).toEqual([...(leadingText ? ["text"] : []), "image", "text", "text", "text", "file", "text", "text"]);
    expect(bodies.filter((segments) => segments[0].type === "text").map((segments) => segments[0].data.text)).toEqual([
      ...(leadingText ? ["before"] : []), "🌸".repeat(1500), "🌸", "between", "第二个说明", "after",
    ]);
    expect(messages.slice(1).flat().some((segment) => ["reply", "at"].includes(segment.type))).toBe(false);
    expect(bodies.find((segments) => segments[0].type === "file")![0].data.name).toBe("fixture.txt");
  });
  it("delivers the maximum contract caption without truncation and uses its final receipt", async () => {
    const f = await mediaFixture(); const request = f.request(); const caption = "字".repeat(32768);
    request.parts = [uploadPart(f, request, { kind: "video", caption })];
    const result = await f.session.send(request);
    const sends = f.actions.filter((a) => a.action.startsWith("send_"));
    expect(sends).toHaveLength(23);
    const chunks = sends.slice(1).map((a) => (a.params.message as { data: { text: string } }[])[0].data.text);
    expect(chunks.every((text) => Array.from(text).length <= 1500)).toBe(true);
    expect(chunks.join("")).toBe(caption);
    expect(result.parts).toEqual([{ partIndex: 0, outcome: "sent", messageId: String(f.actions.indexOf(sends.at(-1)!) + 1) }]);
  });
  it.each(["rejected", "timeout", "invalid-receipt", "disconnected"] as const)("never acknowledges a partially sent media caption after %s", async (failure) => {
    let sends = 0;
    const f = await mediaFixture((action, socket) => {
      if (!action.action.startsWith("send_") || ++sends !== 3) return false;
      if (failure === "rejected") socket.send(JSON.stringify({ status: "failed", retcode: 1, echo: action.echo, data: null }));
      else if (failure === "invalid-receipt") socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: action.echo, data: { message_id: {} } }));
      else if (failure === "disconnected") socket.close();
      return true;
    });
    const request = f.request(); const media = uploadPart(f, request, { kind: "image", caption: "字".repeat(4501) });
    request.parts = [media];
    const result = await f.session.send(request);
    expect(result).toEqual({ operationId: request.operationId, outcome: "unknown", parts: [{ partIndex: 0, outcome: "unknown",
      errorCode: failure === "invalid-receipt" ? "internal" : failure }] });
    expect(sends).toBe(3); // Attachment + first caption confirmed; stop at the next failed fragment.
    expect((await f.session.send(request)).outcome).toBe("failed"); expect(sends).toBe(3);
    expect(() => f.session.mediaWrite({ connectionEpoch: 1, mediaId: media.mediaId, offset: 0, data: Buffer.from("x").toString("base64") })).toThrow();
  });
  it("reports unknown when the first caption is rejected after its attachment was confirmed, while preserving other text parts", async () => {
    let sends = 0;
    const f = await mediaFixture((action, socket) => {
      if (!action.action.startsWith("send_") || ++sends !== 2) return false;
      socket.send(JSON.stringify({ status: "failed", retcode: 1, echo: action.echo, data: null })); return true;
    });
    const request = f.request(); request.parts = [uploadPart(f, request, { kind: "file", caption: "not delivered" }), { kind: "text", text: "still sent" }];
    const result = await f.session.send(request);
    expect(result).toMatchObject({ outcome: "unknown", parts: [{ outcome: "unknown", errorCode: "rejected" }, { outcome: "sent" }] });
    expect(sends).toBe(3);
  });
  it("reports an explicit attachment rejection as partial and never sends its caption or repeats the group prefix", async () => {
    let sends = 0;
    const f = await mediaFixture((action, socket) => {
      if (!action.action.startsWith("send_") || ++sends !== 1) return false;
      socket.send(JSON.stringify({ status: "failed", retcode: 1, echo: action.echo, data: null })); return true;
    });
    const request = { ...f.request(), conversation: { type: "group" as const, groupId: "20001" }, replyContext: { messageId: "70", mentionUserId: "10002" } };
    request.parts = [uploadPart(f, request, { kind: "image", caption: "must not send" }), { kind: "text", text: "independent" }];
    expect(await f.session.send(request)).toMatchObject({ outcome: "partial", parts: [{ outcome: "failed", errorCode: "rejected" }, { outcome: "sent" }] });
    const actions = f.actions.filter((a) => a.action === "send_group_msg");
    expect(actions).toHaveLength(2);
    expect(actions[0].params.message).toMatchObject([{ type: "reply" }, { type: "at" }, { type: "text" }, { type: "image" }]);
    expect(actions[1].params.message).toEqual([{ type: "text", data: { text: "independent" } }]);
  });
  it("does not send caption after an invalid attachment receipt", async () => {
    const f = await mediaFixture((action, socket) => {
      if (!action.action.startsWith("send_")) return false;
      socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: action.echo, data: {} })); return true;
    });
    const request = f.request(); request.parts = [uploadPart(f, request, { kind: "audio", caption: "not confirmed" })];
    expect(await f.session.send(request)).toMatchObject({ outcome: "unknown", parts: [{ outcome: "unknown", errorCode: "internal" }] });
    expect(f.actions.filter((a) => a.action.startsWith("send_"))).toHaveLength(1);
  });
  it("rejects a changed caption binding before upload and preserves the first reply for the next text", async () => {
    const f = await mediaFixture(); const request = { ...f.request(), conversation: { type: "group" as const, groupId: "20001" }, replyContext: { messageId: "70", mentionUserId: "10002" } };
    const media = uploadPart(f, request, { kind: "image", caption: "authorized" });
    const initialUploads = f.actions.filter((a) => a.action === "upload_file_stream").length;
    request.parts = [{ ...media, caption: "changed" }, { kind: "text", text: "independent" }];
    expect(await f.session.send(request)).toMatchObject({ outcome: "partial", parts: [{ outcome: "failed", errorCode: "rejected" }, { outcome: "sent" }] });
    expect(f.actions.filter((a) => a.action === "upload_file_stream")).toHaveLength(initialUploads);
    const sends = f.actions.filter((a) => a.action === "send_group_msg"); expect(sends).toHaveLength(1);
    expect(sends[0].params.message).toMatchObject([{ type: "reply" }, { type: "at" }, { type: "text" }, { type: "text", data: { text: "independent" } }]);
    expect(() => f.session.mediaWrite({ connectionEpoch: 1, mediaId: media.mediaId, offset: 0, data: Buffer.from("x").toString("base64") })).toThrow();
  });
  it("applies one send budget across attachment, caption fragments and following parts", async () => {
    const f = await mediaFixture(undefined, { sendBudgetMs: 100, sendDelayMs: 1000, actionTimeoutMs: 1000 });
    const request = f.request(); request.parts = [uploadPart(f, request, { kind: "video", caption: "字".repeat(3001) }), { kind: "text", text: "after budget" }];
    expect(await f.session.send(request)).toMatchObject({ outcome: "unknown", parts: [
      { outcome: "unknown", errorCode: "timeout" }, { outcome: "failed", errorCode: "timeout" },
    ] });
    expect(f.actions.filter((a) => a.action.startsWith("send_"))).toHaveLength(1);
  });
  it('bounds failed download attempts and lets the next queued text message through', async () => {
    const f = await mediaFixture((action, socket) => {
      if (!action.action.startsWith('download_file_')) return false;
      socket.send(JSON.stringify({ status: 'failed', retcode: 1, echo: action.echo, wording: 'unavailable' }));
      return true;
    });
    f.socket.send(JSON.stringify(f.message({ message: [
      { type: 'text', data: { text: 'preserved' } },
      ...Array.from({ length: 1023 }, (_, i) => ({ type: 'image', data: { file: `image_${i}` } })),
    ] })));
    f.socket.send(JSON.stringify(f.message({ message_id: 5002 })));
    await vi.waitFor(() => expect(f.inbound).toHaveLength(2));
    expect(f.actions.filter((action) => action.action.startsWith('download_file_'))).toHaveLength(16);
    expect(f.inbound[0].text).toContain('preserved');
    expect(f.inbound[0].attachments).toBeUndefined();
    expect(f.inbound[1].backendMessageId).toBe('5002');
  });

  it('shares the message budget, cleans a timed-out partial stream and ignores late packets', async () => {
    let downloads = 0;
    let stalled: Action | undefined;
    const f = await mediaFixture((action, socket) => {
      if (action.action === 'get_msg') return true;
      if (!action.action.startsWith('download_file_')) return false;
      downloads++;
      if (downloads === 1 || action.params.file_id === 'next') return false;
      if (downloads === 2) {
        setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ status: 'failed', retcode: 1, echo: action.echo }));
        }, 20);
      } else if (downloads === 3) {
        stalled = action;
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo,
          data: { type: 'stream', data_type: 'file_info', file_size: 1, chunk_size: 65536 } }));
      } else socket.send(JSON.stringify({ status: 'failed', retcode: 1, echo: action.echo }));
      return true;
    }, { normalizationBudgetMs: 100, actionTimeoutMs: 1000 });
    const heartbeat = setInterval(() => {
      if (f.socket.readyState === WebSocket.OPEN) f.socket.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' }));
    }, 10);
    cleanups.push(async () => { clearInterval(heartbeat); });
    const started = performance.now();
    f.socket.send(JSON.stringify(f.message({ message: [
      ...['kept', 'failed', 'stalled', 'skipped'].map((file) => ({ type: 'image', data: { file } })),
      { type: 'reply', data: { id: 'late-reply' } },
      { type: 'text', data: { text: 'preserved' } },
    ] })));
    f.socket.send(JSON.stringify(f.message({ message_id: 5002 })));
    await vi.waitFor(() => expect(f.inbound).toHaveLength(2));
    expect(performance.now() - started).toBeLessThan(750);
    // An early timer may leave one millisecond of the shared budget. It must
    // not renew that budget or leave the partial download alive.
    expect(downloads).toBeGreaterThanOrEqual(3);
    expect(downloads).toBeLessThanOrEqual(4);
    expect(f.actions.filter((action) => action.action === 'get_msg').length).toBeLessThanOrEqual(1);
    const first = f.inbound[0];
    expect(first.attachments).toHaveLength(1);
    expect(first.text).toContain('preserved');
    expect(first.reply).toEqual({ messageId: 'late-reply' });
    for (const data of [
      { type: 'stream', data_type: 'file_chunk', index: 0, size: 1, data: 'eA==' },
      { type: 'response', data_type: 'file_complete', total_chunks: 1, total_bytes: 1 },
    ]) f.socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: stalled!.echo, data }));
    f.socket.send(JSON.stringify(f.message({ message_id: 5003 })));
    await vi.waitFor(() => expect(f.inbound).toHaveLength(3));
    // The earlier success still belongs to the host; the partial/late stream
    // owns neither a slot nor quota, and did not revive after timeout.
    expect(f.session.mediaRead({ connectionEpoch: 1, eventId: first.eventId, mediaId: first.attachments![0].mediaId, offset: 0, limit: 65536 }).eof).toBe(true);
    const reservations = Array.from({ length: 255 }, (_, i) => f.session.mediaBeginUpload({
      connectionEpoch: 1, operationId: `deadline_${i}`, conversation: { type: 'private', peerId: '10002' },
      media: { kind: 'file', size: 1 }, sha256: '0'.repeat(64),
    }));
    for (const reservation of reservations) f.session.mediaRelease({ connectionEpoch: 1, ...reservation });
    f.socket.send(JSON.stringify(f.message({ message_id: 5004, message: [{ type: 'image', data: { file: 'next' } }] })));
    await vi.waitFor(() => expect(f.inbound).toHaveLength(4));
    expect(f.inbound[3].attachments).toHaveLength(1);
  });

  it('shares the budget with nickname and reply lookups before downloading media', async () => {
    // Advance the monotonic clock through the whole budget on the stalled
    // request. Real timers may fire a fraction early, so do not use their
    // scheduling precision to assert that no budget remains.
    const now = performance.now.bind(performance);
    let elapsed = 0;
    const f = await mediaFixture((action) => {
      if (action.action === 'get_group_member_info') { elapsed = 50; return true; }
      return action.action === 'get_msg';
    },
      { normalizationBudgetMs: 50, actionTimeoutMs: 1000 });
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + elapsed);
    cleanups.push(async () => { clock.mockRestore(); });
    f.socket.send(JSON.stringify(f.message({ message_type: 'group', group_id: '20001', message: [
      { type: 'at', data: { qq: '10001' } },
      { type: 'reply', data: { id: 'original' } },
      { type: 'image', data: { file: 'skipped' } },
      { type: 'text', data: { text: 'preserved' } },
    ] })));
    f.socket.send(JSON.stringify(f.message({ message_id: 5002 })));
    await vi.waitFor(() => expect(f.inbound).toHaveLength(2));
    expect(f.actions.filter((action) => action.action === 'get_group_member_info')).toHaveLength(1);
    expect(f.actions.filter((action) => action.action === 'get_msg' || action.action.startsWith('download_file_'))).toHaveLength(0);
    expect(f.inbound[0]).toMatchObject({ text: '[附件不可用:image]preserved', reply: { messageId: 'original' }, mentions: [{ userId: '10001' }] });
  });

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
