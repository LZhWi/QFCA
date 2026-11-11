import {
  validateSendRequest, validateSendResult, validateRuntimeConfig, validateCapabilitySnapshot,
  QQ_RUNTIME_TIMEOUTS,
  type QqRuntimeConfig, type QqBackendStatus, type QqInboundMessageV1,
  type QqSendRequestV1, type QqSendResultV1, type QqCapabilitySnapshot, type QqPartResult,
} from "../contract";
import { OneBotActionClient, OneBotActionError, OneBotTransportError } from "../onebot/onebot-action-client";
import { OneBotReverseWsServer, type OneBotListeningInfo } from "../onebot/onebot-reverse-ws";
import { isOneBotMessageEvent, oneBotId, type OneBotSegment } from "../onebot/onebot-types";
import { isQqEventAllowed, normalizeOneBotMessage, splitQqText } from "../onebot/codec";

/** Media stays disabled until a host-owned media broker and backend probe exist. */
export const TEXT_CAPABILITIES: QqCapabilitySnapshot = {
  messages: { text: true, image: false, audio: false, file: false, video: false, markdown: false,
    card: false, sticker: false, reply: true, mention: true, maxTextLength: 32768, maxFileBytes: 0 },
  backend: { napcatStream: false },
};
export interface QqSessionOptions {
  config: QqRuntimeConfig;
  accessToken: string;
  runtimeEpoch: number;
  onInbound: (message: QqInboundMessageV1) => void | Promise<void>;
  onStatus?: (status: QqBackendStatus) => void;
  onDiagnostic?: (code: "transport" | "handshake" | "event" | "overloaded") => void;
  /** Test controls, not exposed through IPC. */
  actionTimeoutMs?: number;
  sendDelayMs?: number;
  sendBudgetMs?: number;
}

/** No settings files, Electron, plugin SDK, sessions, workspace, LLM or storage access. */
export class QqOneBotSession {
  private readonly config: QqRuntimeConfig;
  private readonly server: OneBotReverseWsServer;
  private client: OneBotActionClient | null = null;
  private connectionEpoch = 0;
  private status: QqBackendStatus = { phase: "waiting-backend" };
  private running = false;
  private accepting = false;
  private generation = 0;
  private receiveChain: Promise<void> = Promise.resolve();
  private sendChain: Promise<unknown> = Promise.resolve();
  private lifecycle: Promise<unknown> = Promise.resolve();
  private queuedSends = 0;
  private seen = new Map<string, number>();
  private operations = new Set<string>();

  constructor(private readonly options: QqSessionOptions) {
    if (!validateRuntimeConfig(options.config) || !Number.isSafeInteger(options.runtimeEpoch) || options.runtimeEpoch < 0) {
      throw new Error("Invalid QQ module initialization");
    }
    if (options.sendDelayMs !== undefined && (!Number.isFinite(options.sendDelayMs) || options.sendDelayMs < 0 || options.sendDelayMs > 1000)) {
      throw new Error("Invalid QQ send delay");
    }
    if (options.sendBudgetMs !== undefined && (!Number.isSafeInteger(options.sendBudgetMs) || options.sendBudgetMs < 1 || options.sendBudgetMs > QQ_RUNTIME_TIMEOUTS.sendBudgetMs)) {
      throw new Error("Invalid QQ send budget");
    }
    this.config = structuredClone(options.config);
    this.server = new OneBotReverseWsServer({
      ...this.config.listen, accessToken: options.accessToken, expectedSelfId: this.config.expectedSelfId,
      actionTimeoutMs: options.actionTimeoutMs,
      onClientConnected: async (client, selfId) => {
        const generation = this.generation;
        const login = await client.call<{ user_id?: unknown }>("get_login_info");
        if (!login || oneBotId(login.user_id) !== selfId) throw new Error("QQ account mismatch");
        if (!this.running || generation !== this.generation || this.server.client !== client) return;
        this.client = client;
        this.connectionEpoch++;
        this.setStatus({ phase: "running", selfId, connectionEpoch: this.connectionEpoch });
      },
      onClientDisconnected: () => { this.client = null; this.setStatus({ phase: "waiting-backend" }); },
      onEvent: (event, client) => this.receive(event, client),
      onError: (code) => options.onDiagnostic?.(code),
    });
    if (!validateCapabilitySnapshot(TEXT_CAPABILITIES)) throw new Error("Invalid built-in capability declaration");
  }
  private setStatus(status: QqBackendStatus): void {
    this.status = status;
    this.options.onStatus?.(structuredClone(status));
  }
  getStatus(): QqBackendStatus { return structuredClone(this.status); }
  get info(): OneBotListeningInfo | null { return this.server.info; }
  start(): Promise<QqBackendStatus> {
    const next = this.lifecycle.then(async () => {
      if (!this.running) {
        this.running = true;
        this.accepting = true;
        this.generation++;
        try { await this.server.start(); }
        catch (error) { this.running = false; this.accepting = false; throw error; }
      }
      return this.getStatus();
    });
    this.lifecycle = next.catch(() => undefined);
    return next;
  }
  quiesce(): void { this.accepting = false; }
  stop(): Promise<void> {
    // Invalidate work immediately, even if start() is still awaiting bind.
    this.accepting = false;
    this.generation++;
    const next = this.lifecycle.then(async () => {
      this.running = false;
      this.accepting = false;
      await this.server.stop();
      this.client = null;
      this.status = { phase: "waiting-backend" };
      this.seen.clear();
      this.receiveChain = Promise.resolve();
      // Never await a host callback during shutdown. No late callback can emit
      // another message because receive() checks generation after all awaits.
    });
    this.lifecycle = next.catch(() => undefined);
    return next;
  }
  private receive(value: unknown, client: OneBotActionClient): Promise<void> {
    if (!this.accepting || !this.running || this.client !== client || this.server.client !== client) return Promise.resolve();
    if (!isOneBotMessageEvent(value) || value.post_type !== "message") return Promise.resolve();
    if (oneBotId(value.self_id) !== this.config.expectedSelfId || oneBotId(value.user_id) === this.config.expectedSelfId) return Promise.resolve();
    if (!isQqEventAllowed(value, this.config, this.config.expectedSelfId)) return Promise.resolve();
    const epoch = this.connectionEpoch;
    const generation = this.generation;
    const next = this.receiveChain.then(async () => {
      if (!this.accepting || generation !== this.generation || this.client !== client || this.server.client !== client) return;
      const message = await normalizeOneBotMessage(value, {
        selfId: this.config.expectedSelfId, connectionEpoch: epoch,
        configRevision: this.config.configRevision, client,
      });
      if (!this.accepting || generation !== this.generation || epoch !== this.connectionEpoch || this.server.client !== client) return;
      const now = Date.now();
      for (const [id, expires] of this.seen) if (expires <= now) this.seen.delete(id);
      if (this.seen.has(message.eventId)) return;
      if (this.seen.size >= 4096) this.seen.delete(this.seen.keys().next().value!);
      this.seen.set(message.eventId, now + 10 * 60_000);
      await this.options.onInbound(message);
    });
    this.receiveChain = next.catch(() => undefined);
    return next;
  }
  send(value: unknown): Promise<QqSendResultV1> {
    if (!validateSendRequest(value)) return Promise.reject(new Error("Invalid QQ send request"));
    const request = structuredClone(value);
    const fail = (code: "rejected" | "backend-unavailable") => this.result(request, request.parts.map((_, partIndex) => ({ partIndex, outcome: "failed", errorCode: code })));
    if (request.selfId !== this.config.expectedSelfId || request.runtimeEpoch !== this.options.runtimeEpoch || request.connectionEpoch !== this.connectionEpoch) return Promise.resolve(fail("rejected"));
    const allowed = request.conversation.type === "group"
      ? this.config.allowedGroupIds.includes(request.conversation.groupId)
      : this.config.allowedPrivateUserIds.includes(request.conversation.peerId);
    if (!allowed || this.operations.has(request.operationId)) return Promise.resolve(fail("rejected"));
    if (!this.running || !this.client || this.queuedSends >= 64) return Promise.resolve(fail("backend-unavailable"));
    // Bounded in-memory replay guard. Do not evict and allow an old operation
    // to re-send; stop accepting new operations when the epoch budget is used.
    if (this.operations.size >= 10000) return Promise.resolve(fail("rejected"));
    this.operations.add(request.operationId);
    this.queuedSends++;
    const client = this.client;
    const generation = this.generation;
    const deadline = performance.now() + (this.options.sendBudgetMs ?? QQ_RUNTIME_TIMEOUTS.sendBudgetMs);
    const next = this.sendChain.then(() => this.sendNow(request, client, generation, deadline));
    this.sendChain = next.catch(() => undefined);
    return next.finally(() => { this.queuedSends--; });
  }
  private async sendNow(request: QqSendRequestV1, client: OneBotActionClient, generation: number, deadline: number): Promise<QqSendResultV1> {
    const results: QqPartResult[] = [];
    let firstPayload = true;
    for (const [partIndex, part] of request.parts.entries()) {
      if (part.kind !== "text") { results.push({ partIndex, outcome: "failed", errorCode: "unsupported" }); continue; }
      const chunks = splitQqText(part.text);
      if (!chunks.length) { results.push({ partIndex, outcome: "failed", errorCode: "rejected" }); continue; }
      let sent = 0;
      let lastMessageId: string | undefined;
      let failed: QqPartResult | undefined;
      for (const text of chunks) {
        const remaining = deadline - performance.now();
        if (remaining < 1) {
          failed = { partIndex, outcome: sent ? "unknown" : "failed", errorCode: "timeout" }; break;
        }
        if (!this.running || generation !== this.generation || request.connectionEpoch !== this.connectionEpoch || this.client !== client || this.server.client !== client) {
          failed = { partIndex, outcome: sent ? "unknown" : "failed", errorCode: "disconnected" }; break;
        }
        const segments: OneBotSegment[] = [{ type: "text", data: { text } }];
        if (firstPayload && request.conversation.type === "group" && request.replyContext) {
          segments.unshift({ type: "reply", data: { id: request.replyContext.messageId } });
          if (request.replyContext.mentionUserId) segments.splice(1, 0,
            { type: "at", data: { qq: request.replyContext.mentionUserId } }, { type: "text", data: { text: " " } });
        }
        firstPayload = false;
        try {
          const response = await client.call<{ message_id?: unknown }>(request.conversation.type === "group" ? "send_group_msg" : "send_private_msg", {
            [request.conversation.type === "group" ? "group_id" : "user_id"]: request.conversation.type === "group" ? request.conversation.groupId : request.conversation.peerId,
            message: segments,
          }, Math.min(this.options.actionTimeoutMs ?? 30_000, remaining));
          const id = response && oneBotId(response.message_id);
          if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
            failed = { partIndex, outcome: "unknown", errorCode: "internal" }; break;
          }
          lastMessageId = id;
          sent++;
        } catch (error) {
          const code = error instanceof OneBotActionError ? "rejected"
            : error instanceof OneBotTransportError && error.code === "timeout" ? "timeout"
            : error instanceof OneBotTransportError && error.code === "disconnected" ? "disconnected" : "internal";
          const definitelyNotSent = error instanceof OneBotActionError
            || error instanceof OneBotTransportError && ["unavailable", "overloaded"].includes(error.code);
          failed = { partIndex, outcome: sent || !definitelyNotSent ? "unknown" : "failed", errorCode: code };
          break;
        }
        const delay = Math.min(this.options.sendDelayMs ?? 500, Math.max(0, deadline - performance.now()));
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.ceil(delay)));
      }
      results.push(failed ?? { partIndex, outcome: "sent", messageId: lastMessageId! });
    }
    return this.result(request, results);
  }
  private result(request: QqSendRequestV1, parts: QqPartResult[]): QqSendResultV1 {
    const outcome = parts.some((p) => p.outcome === "unknown") ? "unknown"
      : parts.every((p) => p.outcome === "sent") ? "sent"
      : parts.some((p) => p.outcome === "sent") ? "partial" : "failed";
    const result = { operationId: request.operationId, outcome, parts } as QqSendResultV1;
    if (!validateSendResult(result, request)) throw new Error("Invalid QQ send result");
    return result;
  }
}
