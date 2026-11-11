import { describe, expect, it, vi } from "vitest";
import { QqProtocolEndpoint } from "./endpoint";
import type { QqEnvelope, QqMethod, QqRequestPayloads } from "../contract";

function request<K extends QqMethod>(method: K, payload: QqRequestPayloads[K], id: string = method) {
  return { kind: "request", apiVersion: { major: 1, minor: 0 }, instanceId: "instance", runtimeEpoch: 5,
    requestId: id, method, payload };
}
const initialize = { config: { configRevision: 0, listen: { host: "127.0.0.1", port: 3001 }, expectedSelfId: "10001",
  allowedPrivateUserIds: ["10002"], allowedGroupIds: [], groupRequireMention: true }, credentials: { accessToken: "secret" } };
describe("QqProtocolEndpoint", () => {
  it("orders hello/initialize/start and rejects duplicate, extra-field and stale envelopes", async () => {
    const output: QqEnvelope[] = [];
    const start = vi.fn(async () => ({ phase: "waiting-backend" as const }));
    const endpoint = new QqProtocolEndpoint((value) => output.push(value), () => ({ start, stop: async () => undefined, quiesce: () => undefined, send: vi.fn() }));
    expect(await endpoint.receive(request("start", {}))).toBe(false);
    expect(output).toHaveLength(0);
    await endpoint.receive(request("hello", {}));
    await endpoint.receive(request("initialize", initialize));
    expect(JSON.stringify(output)).not.toContain("secret");
    await endpoint.receive(request("start", {}, "start2"));
    expect(start).toHaveBeenCalledTimes(1);
    expect(await endpoint.receive(request("start", {}, "start2"))).toBe(false);
    expect(await endpoint.receive({ ...request("stop", {}), runtimeEpoch: 4 })).toBe(false);
    expect(await endpoint.receive({ ...request("stop", {}), permissionMode: "trusted" })).toBe(false);
    expect(await endpoint.receive({ ...request("stop", {}), apiVersion: { major: 1, minor: 1 } })).toBe(false);
    await endpoint.close();
  });
  it.each(["0.0.0.0", "::", "172.28.64.1", "192.168.1.10", "::ffff:192.168.1.10", "localhost"])("fails closed for %s despite a token, and permits corrected initialization", async (host) => {
    const output: QqEnvelope[] = [];
    const endpoint = new QqProtocolEndpoint((value) => output.push(value));
    await endpoint.receive(request("hello", {}));
    await endpoint.receive(request("initialize", { ...initialize, config: { ...initialize.config, listen: { host, port: 3001 } } }));
    expect(output.at(-1)).toMatchObject({ ok: false, error: { code: "invalid-request" } });
    await endpoint.receive(request("start", {}));
    expect(output.at(-1)).toMatchObject({ ok: false, error: { code: "not-initialized" } });
    await endpoint.receive(request("initialize", initialize, "corrected"));
    expect(output.at(-1)).toMatchObject({ responseTo: "corrected", ok: true });
    expect(JSON.stringify(output)).not.toContain("secret");
    await endpoint.close();
  });
  it("never executes a replay after a busy terminal response", async () => {
    const output: QqEnvelope[] = [];
    const endpoint = new QqProtocolEndpoint((value) => output.push(value));
    await endpoint.receive(request("hello", {}));
    const pending = Array.from({ length: 64 }, (_, i) => endpoint.receive(request("ping", {}, `ping_${i}`)));
    const busy = request("ping", {}, "busy");
    await endpoint.receive(busy);
    await Promise.all(pending);
    expect(await endpoint.receive(busy)).toBe(false);
    expect(output.filter((v) => v.kind === "response" && v.responseTo === "busy")).toEqual([
      expect.objectContaining({ ok: false, error: { code: "busy" } }),
    ]);
    await endpoint.close();
  });
  it("allows stop to interrupt a pending send instead of deadlocking behind it", async () => {
    const output: QqEnvelope[] = [];
    let resolveSend!: (v: unknown) => void;
    const send = vi.fn(() => new Promise<any>((resolve) => { resolveSend = resolve; }));
    const endpoint = new QqProtocolEndpoint((value) => output.push(value), () => ({
      start: async () => ({ phase: "waiting-backend" }), send, quiesce: () => undefined,
      stop: async () => { resolveSend?.({ operationId: "op", outcome: "unknown", parts: [{ partIndex: 0, outcome: "unknown", errorCode: "disconnected" }] }); },
    }));
    await endpoint.receive(request("hello", {}));
    await endpoint.receive(request("initialize", initialize));
    await endpoint.receive(request("start", {}));
    const pending = endpoint.receive(request("send", { operationId: "op", runtimeEpoch: 5, connectionEpoch: 1, selfId: "10001", conversation: { type: "private", peerId: "10002" }, parts: [{ kind: "text", text: "hi" }] }));
    await endpoint.receive(request("stop", {}));
    await pending;
    expect(output.some((v) => v.kind === "response" && v.responseTo === "send" && v.ok)).toBe(true);
    await endpoint.close();
  });
  it("admits quiesce, ACK and stop with all 64 work slots occupied", async () => {
    const output: QqEnvelope[] = [];
    const releases: (() => void)[] = [];
    const quiesce = vi.fn();
    const endpoint = new QqProtocolEndpoint((value) => output.push(value), () => ({
      start: async () => ({ phase: "waiting-backend" }), quiesce,
      send: (value) => new Promise((resolve) => releases.push(() => resolve({
        operationId: (value as { operationId: string }).operationId, outcome: "unknown",
        parts: [{ partIndex: 0, outcome: "unknown", errorCode: "disconnected" }],
      }))),
      stop: async () => { releases.forEach((release) => release()); },
    }));
    await endpoint.receive(request("hello", {}));
    await endpoint.receive(request("initialize", initialize));
    await endpoint.receive(request("start", {}));
    const pending = Array.from({ length: 64 }, (_, i) => endpoint.receive(request("send", {
      operationId: `op_${i}`, runtimeEpoch: 5, connectionEpoch: 1, selfId: "10001",
      conversation: { type: "private", peerId: "10002" }, parts: [{ kind: "text", text: "hi" }],
    }, `send_${i}`)));
    expect(releases).toHaveLength(64);
    await endpoint.receive(request("ping", {}, "overflow"));
    await endpoint.receive(request("quiesce", {}));
    await endpoint.receive(request("ackInbound", { eventId: "event", outcome: "accepted" }));
    await endpoint.receive(request("stop", {}));
    // Clean up even on the unfixed implementation, so the reproduction cannot hang.
    releases.forEach((release) => release());
    await Promise.all(pending);
    expect(output).toContainEqual(expect.objectContaining({ responseTo: "overflow", ok: false, error: { code: "busy" } }));
    for (const method of ["quiesce", "ackInbound", "stop"])
      expect(output).toContainEqual(expect.objectContaining({ responseTo: method, ok: true }));
    expect(quiesce).toHaveBeenCalledOnce();
    for (let i = 0; i < 32; i++) {
      await endpoint.receive(request("quiesce", {}, `recycled_${i}`));
      expect(output.at(-1)).toMatchObject({ responseTo: `recycled_${i}`, ok: true });
    }
    await endpoint.close();
  });
  it("bounds the reserved control queue and retains busy replay protection", async () => {
    const output: QqEnvelope[] = [];
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => { release = resolve; });
    const endpoint = new QqProtocolEndpoint((value) => output.push(value), () => ({
      start: async () => ({ phase: "waiting-backend" }), quiesce: vi.fn(), send: vi.fn(),
      stop: () => stopped,
    }));
    await endpoint.receive(request("hello", {}));
    await endpoint.receive(request("initialize", initialize));
    const pending = Array.from({ length: 16 }, (_, i) => endpoint.receive(request("stop", {}, `stop_${i}`)));
    const overflow = endpoint.receive(request("stop", {}, "control_overflow"));
    await endpoint.receive(request("ping", {}, "work_available"));
    const rejected = output.some((v) => v.kind === "response" && v.responseTo === "control_overflow" && !v.ok && v.error.code === "busy");
    release();
    await Promise.all([...pending, overflow]);
    expect(rejected).toBe(true);
    expect(output).toContainEqual(expect.objectContaining({ responseTo: "work_available", ok: true }));
    expect(await endpoint.receive(request("stop", {}, "control_overflow"))).toBe(false);
    await endpoint.close();
  });
  it("closes visibly after the replay budget instead of silently hanging future stop/ping", async () => {
    const output: QqEnvelope[] = [];
    const endpoint = new QqProtocolEndpoint((value) => output.push(value));
    await endpoint.receive(request("hello", {}));
    for (let i = 0; i < 9999; i++) await endpoint.receive(request("ping", {}, `ping_${i}`));
    await endpoint.receive(request("ping", {}, "exhausted"));
    expect(output.at(-1)).toMatchObject({ responseTo: "exhausted", ok: false, error: { code: "busy" } });
    expect(endpoint.isClosed).toBe(true);
    expect(await endpoint.receive(request("ping", {}, "exhausted"))).toBe(false);
  });
});

it('keeps transfer chunks out of the lifetime control replay budget', async () => {
  const output: QqEnvelope[] = [];
  const endpoint = new QqProtocolEndpoint((value) => output.push(value), () => ({
    start: async () => ({ phase: 'waiting-backend' }), stop: async () => undefined,
    quiesce: () => undefined, send: vi.fn(), mediaWrite: () => ({}),
  }));
  await endpoint.receive(request('hello', {}));
  await endpoint.receive(request('initialize', initialize));
  await endpoint.receive(request('start', {}));
  for (let i = 0; i < 10010; i++) await endpoint.receive(request('mediaWrite', { connectionEpoch: 1, mediaId: 'handle', offset: i, data: 'YQ==' }, `chunk_${i}`));
  await endpoint.receive(request('ping', {}, 'still_alive'));
  expect(endpoint.isClosed).toBe(false);
  expect(output.at(-1)).toMatchObject({ responseTo: 'still_alive', ok: true });
  await endpoint.close();
});
