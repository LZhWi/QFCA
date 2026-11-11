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
async function fixture(response?: (action: Action, socket: WebSocket) => boolean, selfId = "10001", onInbound?: (message: QqInboundMessageV1) => Promise<void>, controls: Pick<QqSessionOptions, "sendBudgetMs" | "sendDelayMs" | "actionTimeoutMs"> = {}) {
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
