// Adapted from Cyrene-Agent; see NOTICE and LICENSES/Cyrene-Agent-MIT.txt.
import * as http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { BlockList, isIP, type Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { OneBotActionClient } from "./onebot-action-client";

export const ONEBOT_WS_PATH = "/onebot/v11/ws";
export const MAX_ONEBOT_PAYLOAD = 256 * 1024;
export interface OneBotReverseWsOptions {
  /** Only unscoped loopback IP literals; remote backends need a secure tunnel. */
  host: string;
  port: number;
  /** Required at runtime, including loopback; existing nonempty tokens keep trim semantics. */
  accessToken?: string;
  expectedSelfId: string;
  heartbeatTimeoutMs?: number;
  actionTimeoutMs?: number;
  onEvent: (event: unknown, client: OneBotActionClient) => void | Promise<void>;
  onClientConnected: (client: OneBotActionClient, selfId: string) => void | Promise<void>;
  onClientDisconnected?: () => void;
  onError?: (code: "transport" | "handshake" | "event" | "overloaded") => void;
}
export interface OneBotListeningInfo { host: string; port: number; path: string; url: string }

// Node's address matcher handles expanded IPv6 and IPv4-mapped IPv6 without
// DNS or prefix-string heuristics. No wildcard or other interface is allowed.
const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("::1", "ipv6");

export function validateListenAddress(host: string, port: number, token = ""): void {
  const family = isIP(host);
  if (!family || host.includes("%")) throw new Error("OneBot host must be an unscoped literal IP address");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid OneBot port");
  if (typeof token !== "string" || token.length > 4096 || /[\r\n\0]/.test(token)) throw new Error("Invalid Access Token");
  if (!loopbackAddresses.check(host, family === 4 ? "ipv4" : "ipv6")) {
    throw new Error("OneBot listeners require a loopback IP address even with an Access Token; use an authenticated encrypted tunnel for remote backends");
  }
  if (!token.trim()) throw new Error("A nonempty Access Token is required");
}
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class OneBotReverseWsServer {
  private httpServer: http.Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private actionClient: OneBotActionClient | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastSeenAt = 0;
  private listeningInfo: OneBotListeningInfo | null = null;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private connections = new Set<Socket>();

  constructor(private readonly options: OneBotReverseWsOptions) {
    validateListenAddress(options.host, options.port, options.accessToken);
    if (!/^[0-9]{1,20}$/.test(options.expectedSelfId)) throw new Error("A confirmed QQ account is required");
    for (const timeout of [options.heartbeatTimeoutMs, options.actionTimeoutMs]) {
      if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000)) {
        throw new Error("Invalid OneBot timeout");
      }
    }
  }
  start(): Promise<OneBotListeningInfo> {
    const next = this.lifecycle.then(() => this.startInternal());
    this.lifecycle = next.catch(() => undefined);
    return next;
  }
  stop(): Promise<void> {
    const next = this.lifecycle.then(() => this.stopInternal());
    this.lifecycle = next.catch(() => undefined);
    return next;
  }
  private report(code: Parameters<NonNullable<OneBotReverseWsOptions["onError"]>>[0]): void {
    try { this.options.onError?.(code); } catch { /* Consumer must not crash socket dispatch. */ }
  }
  private async startInternal(): Promise<OneBotListeningInfo> {
    if (this.listeningInfo) return this.listeningInfo;
    const { host, port, accessToken } = this.options;
    // Options may have changed since construction or a previous start. Check
    // the exact values used below before creating any listener, without DNS.
    validateListenAddress(host, port, accessToken);
    const token = accessToken?.trim() ?? "";
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    server.on("connection", (socket) => {
      this.connections.add(socket);
      socket.once("close", () => this.connections.delete(socket));
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_ONEBOT_PAYLOAD, perMessageDeflate: false });
    wss.on("error", () => this.report("transport"));
    server.on("upgrade", (req, socket, head) => {
      let path: string;
      try { path = new URL(req.url ?? "/", "http://localhost").pathname; }
      catch { socket.destroy(); return; }
      if (path !== ONEBOT_WS_PATH || !tokenMatches(req.headers.authorization, token)) {
        socket.end(`HTTP/1.1 ${path !== ONEBOT_WS_PATH ? "404 Not Found" : "401 Unauthorized"}\r\nConnection: close\r\n\r\n`, () => socket.destroy());
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
    wss.on("connection", (socket, req) => {
      // Even rejected peers can send malformed frames during close handshake.
      socket.on("error", () => this.report("transport"));
      if (req.headers["x-self-id"] !== this.options.expectedSelfId) {
        socket.close(4003, "QQ account does not match confirmed account");
        return;
      }
      this.actionClient?.rejectAll();
      this.socket?.close(4001, "replaced by reconnect");
      const client = new OneBotActionClient(socket, this.options.actionTimeoutMs);
      this.socket = socket;
      this.actionClient = client;
      this.lastSeenAt = Date.now();
      let ready = false;
      let queuedEvents = 0;
      socket.on("message", (raw, binary) => {
        if (this.socket !== socket || binary) return;
        this.lastSeenAt = Date.now();
        let value: unknown;
        try { value = JSON.parse(raw.toString("utf8")); } catch { return; }
        if (client.handleResponse(value)) return;
        if (!ready) return;
        if (queuedEvents >= 64) { this.report("overloaded"); return; }
        queuedEvents++;
        void Promise.resolve().then(() => {
          if (this.socket === socket) return this.options.onEvent(value, client);
        }).catch(() => this.report("event")).finally(() => { queuedEvents--; });
      });
      socket.once("close", () => {
        client.rejectAll();
        if (this.socket === socket) {
          this.socket = null;
          this.actionClient = null;
          try { this.options.onClientDisconnected?.(); } catch { this.report("event"); }
        }
      });
      void Promise.resolve().then(() => this.options.onClientConnected(client, this.options.expectedSelfId))
        .then(() => { if (this.socket === socket) ready = true; })
        .catch(() => {
          this.report("handshake");
          socket.close(4002, "OneBot handshake failed");
          client.rejectAll();
        });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.off("error", reject); resolve(); });
      });
    } catch (error) { wss.close(); server.close(); throw error; }
    server.on("error", () => this.report("transport"));
    this.httpServer = server;
    this.wsServer = wss;
    const address = server.address();
    const actualPort = address && typeof address === "object" ? address.port : port;
    this.listeningInfo = { host, port: actualPort, path: ONEBOT_WS_PATH, url: `ws://${host.includes(":") ? `[${host}]` : host}:${actualPort}${ONEBOT_WS_PATH}` };
    const deadline = this.options.heartbeatTimeoutMs ?? 90_000;
    this.heartbeat = setInterval(() => {
      if (this.socket && Date.now() - this.lastSeenAt > deadline) this.socket.terminate();
    }, Math.min(30_000, Math.max(10, Math.floor(deadline / 3))));
    this.heartbeat.unref();
    return this.listeningInfo;
  }
  private async stopInternal(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.actionClient?.rejectAll();
    this.socket = null;
    this.actionClient = null;
    for (const socket of this.wsServer?.clients ?? []) socket.terminate();
    // closeAllConnections excludes upgraded sockets, including rejected peers
    // that keep their TCP half open. Own all accepted sockets until disposal.
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    this.wsServer?.close();
    this.wsServer = null;
    const server = this.httpServer;
    this.httpServer = null;
    this.listeningInfo = null;
    if (server) await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  get client(): OneBotActionClient | null { return this.actionClient; }
  get info(): OneBotListeningInfo | null { return this.listeningInfo; }
}
