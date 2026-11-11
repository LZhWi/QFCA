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
  it("validates literal bind addresses and requires auth outside loopback", () => {
    expect(() => validateListenAddress("0.0.0.0", 3001)).toThrow("Access Token");
    expect(() => validateListenAddress("::", 3001)).toThrow("Access Token");
    expect(() => validateListenAddress("example.com", 3001, "token")).toThrow("resolved IP");
    expect(() => validateListenAddress("127.0.0.1", 3001)).not.toThrow();
    expect(() => validateListenAddress("::1", 3001)).not.toThrow();
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
