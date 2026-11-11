import * as http from "node:http";
import { connect as connectTcp } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { OneBotReverseWsServer, MAX_ONEBOT_PAYLOAD, validateListenAddress } from "./onebot-reverse-ws";
const servers: OneBotReverseWsServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); });
function server(overrides: Partial<ConstructorParameters<typeof OneBotReverseWsServer>[0]> = {}) {
  const value = new OneBotReverseWsServer({ host: "127.0.0.1", port: 0, expectedSelfId: "10001",
    accessToken: "token", onClientConnected: () => undefined, onEvent: () => undefined, ...overrides });
  servers.push(value); return value;
}
async function connect(url: string, account = "10001") {
  const socket = new WebSocket(url, { headers: { "X-Self-ID": account, Authorization: "Bearer token" } });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return socket;
}
describe("OneBotReverseWsServer", () => {
  it.each([
    "127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1", "::FFFF:7f00:0001", "0:0:0:0:0:ffff:7fff:fffe",
  ])("accepts authenticated loopback literal %s", (host) => {
    for (const token of ["token", "  existing-token  "]) expect(() => validateListenAddress(host, 3001, token)).not.toThrow();
  });
  it.each([
    "0.0.0.0", "::", "192.168.1.10", "172.28.64.1", "10.0.0.1", "169.254.1.1", "8.8.8.8",
    "126.255.255.255", "128.0.0.1", "fe80::1", "fd00::1", "2001:db8::1", "::127.0.0.1",
    "::ffff:0.0.0.0", "::ffff:192.168.1.10", "::FFFF:c0a8:10a", "0:0:0:0:0:ffff:8000:1",
  ])("rejects non-loopback %s even with a token", (host) => {
    for (const token of [undefined, "", "token"]) {
      expect(() => validateListenAddress(host, 3001, token)).toThrow("require a loopback IP address even with an Access Token");
      expect(() => server({ host, accessToken: token })).toThrow("authenticated encrypted tunnel");
    }
  });
  it.each([
    "", "localhost", "localhost.", "example.com", "127.0.0.1.example.com", "127.1", "2130706433",
    "0177.0.0.1", "0x7f000001", "127.000.000.001", "[::1]", "::1%lo", "::1%1", "127.0.0.1 ", "127.0.0.1\0",
  ])("rejects DNS names and ambiguous or scoped addresses: %s", (host) => {
    expect(() => validateListenAddress(host, 3001, "token")).toThrow("unscoped literal IP address");
  });
  it("preserves port and raw token validation on loopback", () => {
    for (const port of [-1, 65536, 1.5, NaN]) expect(() => validateListenAddress("127.0.0.1", port)).toThrow("Invalid OneBot port");
    for (const token of ["token\r", "\ntoken", "token\0", "t".repeat(4097), " ".repeat(4096) + "t", null as unknown as string, 1 as unknown as string]) {
      expect(() => validateListenAddress("127.0.0.1", 3001, token)).toThrow("Invalid Access Token");
    }
  });
  it.each(["127.0.0.1", "127.0.0.2", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::FFFF:7f00:0001"])(
    "binds and accepts authenticated local WebSockets on %s", async (host) => {
      const connected = vi.fn();
      const value = server({ host, onClientConnected: connected });
      const info = await value.start();
      expect(info.host).toBe(host);
      const socket = await connect(info.url);
      await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce());
      socket.terminate();
    },
  );
  it.each([undefined, "", " ", "\t", " \t ", "\u00a0", "\u3000", "\ufeff", "\u2002\u2028\u2029"])(
    "rejects missing or whitespace-only tokens before opening a listener: %j", (accessToken) => {
      expect(() => validateListenAddress("127.0.0.1", 3001, accessToken)).toThrow("nonempty Access Token");
      expect(() => server({ accessToken })).toThrow("nonempty Access Token");
    },
  );
  it("keeps legacy nonempty token trimming without rewriting the supplied credential", async () => {
    const options = { host: "127.0.0.1", port: 0, accessToken: "  \t token \u00a0", expectedSelfId: "10001",
      onClientConnected: () => undefined, onEvent: () => undefined };
    const original = options.accessToken;
    const value = new OneBotReverseWsServer(options); servers.push(value);
    const info = await value.start();
    const socket = await connect(info.url);
    expect(options.accessToken).toBe(original);
    socket.terminate();
  });
  it("revalidates empty tokens on queued start and restart without opening a listener", async () => {
    const options = { host: "127.0.0.1", port: 0, accessToken: "token", expectedSelfId: "10001",
      onClientConnected: () => undefined, onEvent: () => undefined };
    const value = new OneBotReverseWsServer(options); servers.push(value);
    const listen = vi.spyOn(http.Server.prototype, "listen");
    try {
      const pending = value.start(); options.accessToken = "";
      await expect(pending).rejects.toThrow("nonempty Access Token");
      expect(listen).not.toHaveBeenCalled(); expect(value.info).toBeNull();
      options.accessToken = "token"; await value.start(); await value.stop(); listen.mockClear();
      for (const token of ["", " \t ", "\u00a0\u3000"]) {
        options.accessToken = token;
        await expect(value.start()).rejects.toThrow("nonempty Access Token");
        expect(listen).not.toHaveBeenCalled(); expect(value.info).toBeNull();
      }
      options.accessToken = "token";
      const info = await value.start(); const socket = await connect(info.url); socket.terminate();
    } finally { listen.mockRestore(); }
  });
  it("never downgrades a running listener or lets unauthenticated peers replace its client", async () => {
    const connected = vi.fn(); const event = vi.fn();
    const options = { host: "127.0.0.1", port: 0, accessToken: "token", expectedSelfId: "10001",
      onClientConnected: connected, onEvent: event };
    const value = new OneBotReverseWsServer(options); servers.push(value);
    const info = await value.start(); const healthy = await connect(info.url);
    await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce());
    const client = value.client;
    options.accessToken = "";
    expect(await value.start()).toEqual(info);
    for (const authorization of [undefined, "Bearer ", "Bearer wrong", "Basic token", "token"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(info.url, { headers: { "X-Self-ID": "10001",
          ...(authorization === undefined ? {} : { Authorization: authorization }) } });
        ws.on("open", () => { ws.terminate(); reject(new Error("Unauthenticated upgrade accepted")); });
        ws.on("unexpected-response", (_req, res) => { resolve(res.statusCode!); res.resume(); ws.terminate(); });
        ws.on("error", () => undefined);
      });
      expect(status).toBe(401); expect(value.client).toBe(client);
    }
    expect(connected).toHaveBeenCalledOnce();
    healthy.send(JSON.stringify({ post_type: "message" }));
    await vi.waitFor(() => expect(event).toHaveBeenCalledOnce());
    healthy.terminate();
  });
  it("revalidates the exact bind inputs on queued start and restart", async () => {
    const options = { host: "127.0.0.1", port: 0, accessToken: "token", expectedSelfId: "10001",
      onClientConnected: () => undefined, onEvent: () => undefined };
    const value = new OneBotReverseWsServer(options); servers.push(value);
    const listen = vi.spyOn(http.Server.prototype, "listen");
    try {
      const pending = value.start();
      options.host = "0.0.0.0";
      await expect(pending).rejects.toThrow("loopback IP address");
      expect(listen).not.toHaveBeenCalled();
      expect(value.info).toBeNull();
      options.host = "127.0.0.1";
      await value.start(); await value.stop();
      listen.mockClear();
      options.host = "::ffff:192.168.1.10";
      await expect(value.start()).rejects.toThrow("loopback IP address");
      expect(listen).not.toHaveBeenCalled();
      options.host = "localhost";
      await expect(value.start()).rejects.toThrow("literal IP address");
      expect(listen).not.toHaveBeenCalled();
      options.host = "127.0.0.1"; options.accessToken = "token\r";
      await expect(value.start()).rejects.toThrow("Invalid Access Token");
      expect(listen).not.toHaveBeenCalled();
      options.accessToken = "token";
      await value.start();
    } finally { listen.mockRestore(); }
  });
  it("serializes repeated start/stop and closes HTTP keepalive sockets", async () => {
    const value = server();
    const [a, b] = await Promise.all([value.start(), value.start()]);
    expect(a).toEqual(b);
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: a.host, port: a.port, agent }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", reject);
    });
    await Promise.all([value.stop(), value.stop()]);
    agent.destroy();
    expect(value.info).toBeNull();
  });
  it("rejects token query parameters and wrong Authorization headers", async () => {
    const value = server(); const info = await value.start();
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${info.url}?access_token=token`, { headers: { "X-Self-ID": "10001" } });
      ws.on("unexpected-response", (_req, res) => { resolve(res.statusCode!); res.resume(); ws.terminate(); });
      ws.on("error", () => undefined);
    });
    expect(status).toBe(401);
  });
  it("does not dispatch messages before asynchronous handshake completes", async () => {
    let finish!: () => void;
    const event = vi.fn();
    const value = server({ onClientConnected: () => new Promise<void>((resolve) => { finish = resolve; }), onEvent: event });
    const info = await value.start(); const ws = await connect(info.url);
    ws.send(JSON.stringify({ post_type: "message" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(event).not.toHaveBeenCalled();
    finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    ws.send(JSON.stringify({ post_type: "message" }));
    await vi.waitFor(() => expect(event).toHaveBeenCalledOnce());
    ws.terminate();
  });
  it("handles protocol errors even from rejected accounts without crashing", async () => {
    const diagnostic = vi.fn();
    const value = server({ onError: diagnostic }); const info = await value.start();
    const ws = await connect(info.url, "99999");
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    ws.send("unmasked", { mask: false });
    await closed;
    await vi.waitFor(() => expect(value.client).toBeNull());
    // Another authenticated peer can still connect after the malformed frame.
    const healthy = await connect(info.url); healthy.terminate();
  });
  it("closes a malformed failed handshake without crashing and accepts a fresh backend", async () => {
    const diagnostic = vi.fn();
    const value = server({ onError: diagnostic, onClientConnected: async (client) => { await client.call("get_login_info"); } });
    const info = await value.start();
    const malformed = new WebSocket(info.url, { headers: { "X-Self-ID": "10001", Authorization: "Bearer token" } });
    const closed = new Promise<number>((resolve, reject) => { malformed.once("close", resolve); malformed.once("error", reject); });
    malformed.on("message", (raw) => {
      const { echo } = JSON.parse(raw.toString());
      malformed.send(JSON.stringify({ echo, status: "failed", retcode: 1404, wording: { toString: null } }));
    });
    expect(await closed).toBe(4002);
    expect(diagnostic).toHaveBeenCalledWith("handshake");
    const healthy = new WebSocket(info.url, { headers: { "X-Self-ID": "10001", Authorization: "Bearer token" } });
    healthy.on("message", (raw) => {
      const { echo } = JSON.parse(raw.toString());
      healthy.send(JSON.stringify({ echo, status: "ok", retcode: 0, data: { user_id: 10001 } }));
    });
    await new Promise<void>((resolve, reject) => { healthy.once("open", resolve); healthy.once("error", reject); });
    await vi.waitFor(() => expect(value.client?.pendingCount).toBe(0));
    expect(diagnostic).toHaveBeenCalledTimes(1);
    healthy.terminate();
  });
  it("settles malformed backend failures and keeps the same connection usable", async () => {
    const value = server(); const info = await value.start();
    const backend = await connect(info.url);
    backend.on("message", (raw) => {
      const { echo, action } = JSON.parse(raw.toString());
      backend.send(JSON.stringify(action === "bad"
        ? { echo, status: "failed", retcode: 1404, wording: [{ toString: null }], message: { toString: null } }
        : { echo, status: "ok", retcode: 0, data: "alive" }));
    });
    await vi.waitFor(() => expect(value.client).not.toBeNull());
    const client = value.client!;
    await expect(client.call("bad")).rejects.toMatchObject({ name: "OneBotActionError", retcode: 1404 });
    expect(client.pendingCount).toBe(0);
    await expect(client.call("healthy")).resolves.toBe("alive");
    expect(value.client).toBe(client);
    backend.terminate();
  });
  it("rejects oversized frames before JSON parsing and enforces heartbeat cleanup", async () => {
    const value = server({ heartbeatTimeoutMs: 30 }); const info = await value.start();
    const oversized = await connect(info.url);
    const closed = new Promise<number>((resolve) => oversized.once("close", resolve));
    oversized.send("x".repeat(MAX_ONEBOT_PAYLOAD + 1));
    expect(await closed).toBe(1009);
    const silent = await connect(info.url);
    await new Promise<void>((resolve) => silent.once("close", () => resolve()));
    await vi.waitFor(() => expect(value.client).toBeNull());
  });
  it("does not hang stopping after an unauthorized half-open upgrade", async () => {
    const value = server(); const info = await value.start();
    const socket = connectTcp({ host: info.host, port: info.port, allowHalfOpen: true });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const response = new Promise<string>((resolve) => socket.once("data", (data) => resolve(data.toString())));
    socket.write("GET /onebot/v11/ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    expect(await response).toContain("401");
    await value.stop();
    socket.destroy();
    expect(value.info).toBeNull();
  });
});
