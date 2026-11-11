import {
  validateSendRequest, validateSendResult, validateRuntimeConfig, validateCapabilitySnapshot,
  QQ_RUNTIME_TIMEOUTS, validateMediaBeginUpload, validateMediaWrite, validateMediaRead, validateMediaRelease,
  type QqMediaBeginUpload, type QqMediaWrite, type QqMediaRead, type QqMediaRelease,
  type QqRuntimeConfig, type QqBackendStatus, type QqInboundMessageV1,
  type QqSendRequestV1, type QqSendResultV1, type QqCapabilitySnapshot, type QqPartResult,
} from "../contract";
import { MediaSpool } from "./media-spool";
import { probeMedia, uploadMedia, downloadMedia } from "../onebot/media";
import { OneBotActionClient, OneBotActionError, OneBotTransportError } from "../onebot/onebot-action-client";
import { OneBotReverseWsServer, type OneBotListeningInfo } from "../onebot/onebot-reverse-ws";
import { isOneBotMessageEvent, oneBotId, type OneBotSegment } from "../onebot/onebot-types";
import { INBOUND_NORMALIZATION_BUDGET_MS, isQqEventAllowed, normalizeOneBotMessage, oneBotMessageEventId, splitQqText } from "../onebot/codec";

/** Fail-closed baseline; per-connection probes may enable NapCat media. */
export const TEXT_CAPABILITIES: QqCapabilitySnapshot = {
  messages: { text: true, image: false, audio: false, file: false, video: false, markdown: false,
    card: false, sticker: false, reply: true, mention: true, maxTextLength: 32768, maxFileBytes: 0 },
  backend: { napcatStream: false },
};
export interface QqSessionOptions {
  config: QqRuntimeConfig;
  accessToken: string;
  runtimeEpoch: number;
  mediaTransfer?: "chunked-v1";
  onInbound: (message: QqInboundMessageV1) => void | Promise<void>;
  onCapabilities?: (capabilities: QqCapabilitySnapshot) => void;
  onStatus?: (status: QqBackendStatus) => void;
  onDiagnostic?: (code: "transport" | "handshake" | "event" | "overloaded") => void;
  /** Test controls, not exposed through IPC. */
  actionTimeoutMs?: number;
  sendDelayMs?: number;
  sendBudgetMs?: number;
  normalizationBudgetMs?: number;
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
  private readonly spool = new MediaSpool();
  private capabilities = structuredClone(TEXT_CAPABILITIES);

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
    if (options.normalizationBudgetMs !== undefined && (!Number.isSafeInteger(options.normalizationBudgetMs) || options.normalizationBudgetMs < 1 || options.normalizationBudgetMs > INBOUND_NORMALIZATION_BUDGET_MS)) {
      throw new Error("Invalid QQ normalization budget");
    }
    this.config = structuredClone(options.config);
    this.server = new OneBotReverseWsServer({
      ...this.config.listen, accessToken: options.accessToken, expectedSelfId: this.config.expectedSelfId,
      actionTimeoutMs: options.actionTimeoutMs,
      onClientConnected: async (client, selfId) => {
        this.spool.revoke();
        this.capabilities = structuredClone(TEXT_CAPABILITIES);
        this.options.onCapabilities?.(this.capabilities);
        const generation = this.generation;
        const login = await client.call<{ user_id?: unknown }>("get_login_info");
        if (!login || oneBotId(login.user_id) !== selfId) throw new Error("QQ account mismatch");
        if (!this.running || generation !== this.generation || this.server.client !== client) return;
        this.client = client;
        this.connectionEpoch++;
        const epoch = this.connectionEpoch;
        const check = () => { if (!this.running || generation !== this.generation || this.server.client !== client || epoch !== this.connectionEpoch) throw new Error("Stale media connection"); };
        this.setStatus({ phase: "running", selfId, connectionEpoch: epoch });
        // Text becomes ready without waiting for optional extensions. An old probe
        // must not overwrite capabilities after stop or a newer connection.
        if (this.options.mediaTransfer === "chunked-v1") void probeMedia(client, TEXT_CAPABILITIES, check).then((capabilities) => {
          check(); this.capabilities = capabilities;
          this.options.onCapabilities?.(structuredClone(capabilities));
        }).catch(() => undefined);
      },
      onClientDisconnected: () => { this.spool.revoke(); this.capabilities = structuredClone(TEXT_CAPABILITIES); this.options.onCapabilities?.(structuredClone(this.capabilities)); this.client = null; this.setStatus({ phase: "waiting-backend" }); },
      onEvent: (event, client) => this.receive(event, client),
      onError: (code) => options.onDiagnostic?.(code),
    });
    if (!validateCapabilitySnapshot(TEXT_CAPABILITIES)) throw new Error("Invalid built-in capability declaration");
  }
  private setStatus(status: QqBackendStatus): void {
    this.status = status;
    this.options.onStatus?.(structuredClone(status));
  }
  getCapabilities(): QqCapabilitySnapshot { return structuredClone(this.capabilities); }
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
    this.spool.revoke();
    this.capabilities = structuredClone(TEXT_CAPABILITIES);
    this.options.onCapabilities?.(structuredClone(this.capabilities));
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
      const now = Date.now();
      for (const [id, expires] of this.seen) if (expires <= now) this.seen.delete(id);
      const eventId = oneBotMessageEventId(value, this.config.expectedSelfId);
      // The receive chain is serial, so even duplicates queued during the first
      // download are dropped before allocating any new media handles.
      if (this.seen.has(eventId)) return;
      // Until successful host delivery, this receive owns every resolved handle.
      // Normalization may fail after downloads (for example placeholder overflow).
      const downloaded: string[] = [];
      let delivered = false;
      try {
        const message = await normalizeOneBotMessage(value, {
          selfId: this.config.expectedSelfId, connectionEpoch: epoch,
          configRevision: this.config.configRevision, client, actionTimeoutMs: this.options.actionTimeoutMs,
          normalizationBudgetMs: this.options.normalizationBudgetMs,
          ...(this.capabilities.backend.napcatStream ? { resolveMedia: async (segment: OneBotSegment, eventId: string, deadline: number) => {
            const media = await downloadMedia(client, this.spool, epoch, eventId, segment, () => {
              if (!this.accepting || generation !== this.generation || epoch !== this.connectionEpoch || this.server.client !== client) throw new Error("Stale media connection");
            }, deadline);
            downloaded.push(media.mediaId);
            return media;
          } } : {}),
        });
        if (!this.accepting || generation !== this.generation || epoch !== this.connectionEpoch || this.server.client !== client) return;
        if (this.seen.size >= 4096) this.seen.delete(this.seen.keys().next().value!);
        this.seen.set(message.eventId, Date.now() + 10 * 60_000);
        await this.options.onInbound(message);
        delivered = true;
      } finally {
        if (!delivered) for (const mediaId of downloaded) {
          try { this.spool.release(epoch, mediaId); } catch { /* already revoked by disconnect/stop */ }
        }
      }
    });
    this.receiveChain = next.catch(() => undefined);
    return next;
  }
  private checkMediaEpoch(epoch: number): void {
    if (!this.running || !this.client || this.server.client !== this.client || epoch !== this.connectionEpoch || !this.capabilities.backend.napcatStream) throw new Error("Media unavailable");
  }
  mediaBeginUpload(value: QqMediaBeginUpload): { mediaId: string } {
    if (!validateMediaBeginUpload(value)) throw new Error("Invalid media request");
    this.checkMediaEpoch(value.connectionEpoch);
    const allowed = value.conversation.type === "group" ? this.config.allowedGroupIds.includes(value.conversation.groupId) : this.config.allowedPrivateUserIds.includes(value.conversation.peerId);
    if (!allowed || this.operations.has(value.operationId) || !this.capabilities.messages[value.media.kind]) throw new Error("Media rejected");
    return this.spool.begin(value);
  }
  mediaWrite(value: QqMediaWrite): Record<string, never> {
    if (!validateMediaWrite(value)) throw new Error("Invalid media request");
    this.checkMediaEpoch(value.connectionEpoch); this.spool.write(value.connectionEpoch, value.mediaId, value.offset, value.data); return {};
  }
  mediaRead(value: QqMediaRead) {
    if (!validateMediaRead(value)) throw new Error("Invalid media request");
    this.checkMediaEpoch(value.connectionEpoch); return this.spool.read(value.connectionEpoch, value.mediaId, value.eventId, value.offset, value.limit);
  }
  mediaRelease(value: QqMediaRelease): Record<string, never> {
    if (!validateMediaRelease(value)) throw new Error("Invalid media request");
    this.checkMediaEpoch(value.connectionEpoch); this.spool.release(value.connectionEpoch, value.mediaId); return {};
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
    const firstPayload = { pending: true };
    for (const [partIndex, part] of request.parts.entries()) {
      if (part.kind !== "text") {
        const result = await this.sendMedia(request, part, partIndex, client, generation, deadline, firstPayload);
        results.push(result); continue;
      }
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
        if (firstPayload.pending && request.conversation.type === "group" && request.replyContext) {
          segments.unshift({ type: "reply", data: { id: request.replyContext.messageId } });
          if (request.replyContext.mentionUserId) segments.splice(1, 0,
            { type: "at", data: { qq: request.replyContext.mentionUserId } }, { type: "text", data: { text: " " } });
        }
        firstPayload.pending = false;
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
  private async sendMedia(request: QqSendRequestV1, part: QqSendRequestV1["parts"][number], partIndex: number, client: OneBotActionClient, generation: number, deadline: number, firstPayload: { pending: boolean }): Promise<QqPartResult> {
    if (part.kind === "text" || part.kind === "card" || !this.capabilities.messages[part.kind]) return { partIndex, outcome: "failed", errorCode: "unsupported" };
    const check = () => {
      if (!this.running || request.connectionEpoch !== this.connectionEpoch || this.client !== client || this.server.client !== client || generation !== this.generation) throw new OneBotTransportError("disconnected");
      this.checkMediaEpoch(request.connectionEpoch);
      if (deadline - performance.now() < 1) throw new OneBotTransportError("timeout");
    };
    let dispatched = false;
    let sent = 0;
    try {
      check();
      const source = this.spool.claim(request, part);
      const filenameExtension = part.filename?.split('.').pop()?.toLowerCase();
      const mimeExtension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'video/mp4': 'mp4', 'application/pdf': 'pdf' } as Record<string, string>)[part.mime ?? ''];
      const extension = filenameExtension && /^[a-z0-9]{1,8}$/.test(filenameExtension) ? filenameExtension : mimeExtension ?? ({ image: 'png', sticker: 'png', audio: 'audio', video: 'mp4', file: 'bin' } as const)[part.kind];
      const path = await uploadMedia(client, source, check, deadline, extension);
      check();
      const type = part.kind === "audio" ? "record" : part.kind === "sticker" ? "image" : part.kind;
      // Keep the attachment a standalone payload (not all media kinds support
      // mixed segments), then send its caption using the normal text bounds.
      const payloads: OneBotSegment[][] = [
        [{ type, data: { file: path, ...(part.kind === "file" && part.filename ? { name: part.filename } : {}) } }],
        ...splitQqText(part.caption ?? "").map((text) => [{ type: "text", data: { text } }]),
      ];
      let lastMessageId: string | undefined;
      for (const [index, segments] of payloads.entries()) {
        check();
        if (firstPayload.pending && request.conversation.type === "group" && request.replyContext) {
          segments.unshift({ type: "reply", data: { id: request.replyContext.messageId } });
          if (request.replyContext.mentionUserId) segments.splice(1, 0, { type: "at", data: { qq: request.replyContext.mentionUserId } }, { type: "text", data: { text: " " } });
        }
        firstPayload.pending = false;
        dispatched = true;
        const response = await client.call<{ message_id?: unknown }>(request.conversation.type === "group" ? "send_group_msg" : "send_private_msg", {
          [request.conversation.type === "group" ? "group_id" : "user_id"]: request.conversation.type === "group" ? request.conversation.groupId : request.conversation.peerId,
          message: segments,
        }, Math.min(this.options.actionTimeoutMs ?? 30_000, Math.max(1, deadline - performance.now())));
        const id = response && oneBotId(response.message_id);
        if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return { partIndex, outcome: "unknown", errorCode: "internal" };
        sent++;
        dispatched = false;
        lastMessageId = id;
        if (index < payloads.length - 1) {
          const delay = Math.min(this.options.sendDelayMs ?? 500, Math.max(0, deadline - performance.now()));
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.ceil(delay)));
        }
      }
      return { partIndex, outcome: "sent", messageId: lastMessageId! };
    } catch (error) {
      const known = error instanceof OneBotActionError || error instanceof OneBotTransportError && ["unavailable", "overloaded"].includes(error.code);
      return { partIndex, outcome: sent || dispatched && !known ? "unknown" : "failed", errorCode: error instanceof OneBotTransportError && error.code === "timeout" ? "timeout" : error instanceof OneBotTransportError && error.code === "disconnected" ? "disconnected" : "rejected" };
    } finally { try { this.spool.release(request.connectionEpoch, part.mediaId); } catch { /* already revoked */ } }
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
