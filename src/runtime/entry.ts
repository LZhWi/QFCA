import { QqProtocolEndpoint } from "./endpoint";
import type { QqEnvelope } from "../contract";

// Both channels are parent-private. No stdio JSON protocol, management HTTP
// listener, argv token, inherited app configuration, or ordinary plugin API.
interface ParentPort {
  postMessage(message: QqEnvelope): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  on(event: "close", listener: () => void): void;
}
const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (!port && !process.send) throw new Error("QFCA requires a private parent IPC channel");
const endpoint = new QqProtocolEndpoint((message) => {
  if (port) port.postMessage(message);
  else if (process.connected) process.send!(message, (error) => { if (error) shutdown(); });
});
const receive = (message: unknown) => {
  void endpoint.receive(message).then(() => { if (endpoint.isClosed) shutdown(); }).catch(() => shutdown());
};
const shutdown = () => { void endpoint.close().finally(() => process.exit(0)); };
if (port) {
  port.on("message", (event) => receive(event.data));
  port.on("close", shutdown);
} else {
  process.on("message", receive);
  process.once("disconnect", shutdown);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
