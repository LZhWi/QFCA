import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const reserve = createServer();
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const child = fork(fileURLToPath(new URL("../dist/runtime/entry.js", import.meta.url)), [], {
  stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced", env: { NODE_ENV: "test" },
});
const events = [];
const pending = new Map();
let seq = 0;
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.on("message", (message) => {
  if (message.kind === "response") pending.get(message.responseTo)?.(message);
  if (message.kind === "event") events.push(message);
});
function request(method, payload) {
  const requestId = `smoke_${++seq}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 5000);
    pending.set(requestId, (message) => {
      clearTimeout(timeout); pending.delete(requestId);
      if (!message.ok) reject(new Error(`Failed: ${method}: ${message.error.code}`)); else resolve(message.payload);
    });
    child.send({ kind: "request", apiVersion: { major: 1, minor: 0 }, instanceId: "smoke", runtimeEpoch: 1,
      requestId, method, payload });
  });
}
async function waitFor(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("Timed out waiting for module event");
}
let ws;
let malformed;
try {
  const hello = await request("hello", {});
  assert.equal(hello.moduleId, "qfca");
  await assert.rejects(request("initialize", { config: {
    configRevision: 1, listen: { host: "0.0.0.0", port }, expectedSelfId: "10001",
    allowedPrivateUserIds: ["10002"], allowedGroupIds: [], groupRequireMention: true,
  }, credentials: { accessToken: "smoke-token" } }), /Failed: initialize: invalid-request/);
  await assert.rejects(request("start", {}), /Failed: start: not-initialized/);
  for (const accessToken of ["", " \t ", "\u00a0\u3000\ufeff"]) {
    await assert.rejects(request("initialize", { config: {
      configRevision: 1, listen: { host: "127.0.0.1", port }, expectedSelfId: "10001",
      allowedPrivateUserIds: ["10002"], allowedGroupIds: [], groupRequireMention: true,
    }, credentials: { accessToken } }), /Failed: initialize: invalid-request/);
    await assert.rejects(request("start", {}), /Failed: start: not-initialized/);
    await request("ping", {});
  }
  const initialized = await request("initialize", { config: {
    configRevision: 1, listen: { host: "127.0.0.1", port }, expectedSelfId: "10001",
    allowedPrivateUserIds: ["10002"], allowedGroupIds: [], groupRequireMention: true,
  }, credentials: { accessToken: "smoke-token" } });
  assert.equal(initialized.capabilities.messages.image, false);
  assert.equal((await request("start", {})).phase, "waiting-backend");
  malformed = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers: { "X-Self-ID": "10001", Authorization: "Bearer smoke-token" } });
  let malformedCloseCode;
  malformed.on("close", (code) => { malformedCloseCode = code; });
  malformed.on("message", (raw) => {
    const { echo } = JSON.parse(raw.toString());
    malformed.send(JSON.stringify({ echo, status: "failed", retcode: 1404, message: { toString: null } }));
  });
  await waitFor(() => malformedCloseCode !== undefined);
  assert.equal(malformedCloseCode, 4002);
  await request("ping", {}); // Malformed backend JSON must not crash the child.
  ws = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers: { "X-Self-ID": "10001", Authorization: "Bearer smoke-token" } });
  let sendCount = 0;
  ws.on("message", (raw) => {
    const action = JSON.parse(raw.toString());
    if (action.action.startsWith("send_")) sendCount++;
    ws.send(JSON.stringify({ echo: action.echo, status: "ok", retcode: 0,
      data: action.action === "get_login_info" ? { user_id: 10001 } : { message_id: 7001 } }));
  });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  await waitFor(() => events.some((event) => event.event === "status" && event.payload.phase === "running"));
  ws.send(JSON.stringify({ post_type: "message", self_id: 10001, message_id: 6001, message_type: "private", user_id: 10002,
    message: [{ type: "text", data: { text: "smoke" } }] }));
  await waitFor(() => events.some((event) => event.event === "inbound"));
  const inbound = events.find((event) => event.event === "inbound").payload;
  assert.equal(inbound.text, "smoke");
  assert.equal(inbound.channel, undefined);
  await request("ackInbound", { eventId: inbound.eventId, outcome: "accepted" });
  await request("quiesce", {});
  const sent = await request("send", { operationId: "send1", runtimeEpoch: 1, connectionEpoch: 1, selfId: "10001",
    conversation: { type: "private", peerId: "10002" }, parts: [{ kind: "text", text: "reply" }] });
  assert.equal(sent.outcome, "sent");
  assert.equal(sendCount, 1);
  await request("stop", {});
  await request("stop", {});
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.disconnect();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  assert.equal(await exited, 0);
  clearTimeout(timeout);
  assert.equal(stderr, "");
  console.log("PASS: compiled private IPC + non-loopback/blank-token rejection + malformed backend recovery + authenticated fake OneBot + inbound/send/quiesce/stop/disconnect");
} finally {
  malformed?.terminate();
  ws?.terminate();
  if (child.connected) child.disconnect();
  child.kill();
}
