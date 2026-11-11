import {
  QQ_API_SUPPORT, validateEnvelope, validateResponsePayload,
  type QqRequest, type QqResponse, type QqEvent, type QqRuntimeErrorCode,
  type QqInboundMessageV1,
} from "../contract";
import { QqOneBotSession, TEXT_CAPABILITIES, type QqSessionOptions } from "./session";

// package metadata is copied into the signed payload. A rehearsal version is
// explicit and never silently derived by stripping the development suffix.
export const MODULE_VERSION: string = (require("../../package.json") as { version: string }).version;
type Session = Pick<QqOneBotSession, "start" | "stop" | "quiesce" | "send"> & Partial<Pick<QqOneBotSession, "mediaBeginUpload" | "mediaWrite" | "mediaRead" | "mediaRelease">>;
export type SessionFactory = (options: QqSessionOptions) => Session;

/** A private local endpoint, not an arbitrary OneBot-action or plugin port. */
export class QqProtocolEndpoint {
  private identity: Pick<QqRequest, "apiVersion" | "instanceId" | "runtimeEpoch"> | null = null;
  private session: Session | null = null;
  private initialized = false;
  private started = false;
  private closed = false;
  private requests = new Set<string>();
  private inFlightRequests = new Set<string>();
  private pending = 0;
  private pendingControl = 0;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private inboundAcks = new Map<string, () => void>();

  constructor(
    private readonly output: (message: QqResponse | QqEvent) => void,
    private readonly factory: SessionFactory = (options) => new QqOneBotSession(options),
  ) {}

  /** False means malformed, wrong instance or replay; never dispatch it. */
  async receive(value: unknown): Promise<boolean> {
    if (this.closed || !validateEnvelope(value) || value.kind !== "request") return false;
    const request = value;
    if (!this.identity) {
      if (request.method !== "hello") return false;
      this.identity = { apiVersion: request.apiVersion, instanceId: request.instanceId, runtimeEpoch: request.runtimeEpoch };
    }
    if (request.instanceId !== this.identity.instanceId || request.runtimeEpoch !== this.identity.runtimeEpoch) return false;
    if (this.requests.has(request.requestId) || this.inFlightRequests.has(request.requestId)) return false;
    const transferChunk = ["mediaWrite", "mediaRead", "mediaRelease"].includes(request.method);
    // Every terminal response consumes its replay tombstone, including busy.
    // Exhaustion is a visible process failure, never a silent permanently
    // unresponsive "running" module. The entry exits after close, and the
    // host must make an explicit new-instance decision; no replay is made.
    if (!transferChunk && this.requests.size >= 10000) {
      this.respond(request, "busy");
      await this.close();
      return true;
    }
    if (!transferChunk) this.requests.add(request.requestId);
    // Work saturation must not prevent shutdown or inbound pressure relief.
    // Reserve a separate bounded lane; lifecycle ordering remains unchanged.
    const control = ["quiesce", "stop", "ackInbound"].includes(request.method);
    if (control ? this.pendingControl >= 16 : this.pending >= 64) {
      this.respond(request, "busy"); return true;
    }
    this.inFlightRequests.add(request.requestId);
    if (control) this.pendingControl++; else this.pending++;
    try {
      const execute = async () => {
        if (this.closed) return;
        let payload: unknown;
        switch (request.method) {
          case "hello": payload = { moduleId: "qfca", moduleVersion: MODULE_VERSION, apiSupport: { ...QQ_API_SUPPORT } }; break;
          case "initialize": {
            if (this.initialized) { this.respond(request, "invalid-request"); return; }
            try {
              this.session = this.factory({
                config: request.payload.config, accessToken: request.payload.credentials.accessToken,
                runtimeEpoch: request.runtimeEpoch, mediaTransfer: request.payload.mediaTransfer,
                onInbound: (message) => this.inbound(message),
                onCapabilities: (capabilities) => this.event("capability-changed", capabilities),
                onStatus: (status) => this.event("status", status),
              });
            } catch { this.respond(request, "invalid-request"); return; }
            this.initialized = true;
            payload = { capabilities: structuredClone(TEXT_CAPABILITIES) };
            break;
          }
          case "start": {
            if (!this.session) { this.respond(request, "not-initialized"); return; }
            payload = await this.session.start();
            this.started = true;
            break;
          }
          case "send": {
            if (!this.session || !this.started) { this.respond(request, "not-running"); return; }
            payload = await this.session.send(request.payload);
            break;
          }
          case "mediaBeginUpload": case "mediaWrite": case "mediaRead": case "mediaRelease": {
            if (!this.session || !this.started) { this.respond(request, "not-running"); return; }
            // Dispatch narrow, already validated media methods only; old test sessions stay compatible.
            const method = this.session[request.method];
            if (!method) { this.respond(request, "invalid-request"); return; }
            payload = await (method as (value: unknown) => unknown).call(this.session, request.payload);
            break;
          }
          case "quiesce": {
            if (!this.session) { this.respond(request, "not-initialized"); return; }
            this.session.quiesce(); payload = {}; break;
          }
          case "stop": {
            this.started = false;
            this.releaseInbound();
            await this.session?.stop(); payload = {}; break;
          }
          case "ackInbound": {
            // ACK releases transport pressure only, not a full agent turn.
            // No ACK outcome triggers automatic replay or QQ backend action.
            if (!this.session) { this.respond(request, "not-initialized"); return; }
            this.inboundAcks.get(request.payload.eventId)?.();
            payload = {}; break;
          }
          case "ping": payload = {}; break;
        }
        if (!validateResponsePayload(request.method, payload, request.payload)) throw new Error("Invalid module response");
        if (!this.closed) this.output({ ...this.identity!, kind: "response", responseTo: request.requestId, ok: true, payload });
      };
      if (["initialize", "start", "quiesce", "stop"].includes(request.method)) {
        const next = this.lifecycle.then(execute);
        this.lifecycle = next.catch(() => undefined);
        await next;
      } else await execute();
    } catch { if (!this.closed) this.respond(request, "internal"); }
    finally {
      if (control) this.pendingControl--; else this.pending--;
      this.inFlightRequests.delete(request.requestId);
    }
    return true;
  }
  private respond(request: QqRequest, code: QqRuntimeErrorCode): void {
    this.output({ apiVersion: request.apiVersion, instanceId: request.instanceId, runtimeEpoch: request.runtimeEpoch,
      kind: "response", responseTo: request.requestId, ok: false, error: { code } });
  }
  private event<K extends QqEvent["event"]>(event: K, payload: Extract<QqEvent, { event: K }>["payload"]): void {
    if (this.closed || !this.identity) return;
    const envelope = { ...this.identity, kind: "event", event, payload };
    if (!validateEnvelope(envelope)) throw new Error("Invalid module event");
    this.output(envelope as QqEvent);
  }
  private inbound(message: QqInboundMessageV1): Promise<void> {
    if (this.closed || this.inboundAcks.size >= 64 || this.inboundAcks.has(message.eventId)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = () => { clearTimeout(timeout); this.inboundAcks.delete(message.eventId); resolve(); };
      const timeout = setTimeout(finish, 30_000);
      timeout.unref();
      this.inboundAcks.set(message.eventId, finish);
      try { this.event("inbound", message); }
      catch (error) { finish(); reject(error); }
    });
  }
  private releaseInbound(): void {
    for (const finish of this.inboundAcks.values()) finish();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.releaseInbound();
    await this.lifecycle;
    await this.session?.stop();
    this.session = null;
  }
  get isClosed(): boolean { return this.closed; }
}
