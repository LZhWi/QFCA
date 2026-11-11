// Adapted from Cyrene-Agent's MIT-licensed OneBot normalizer and NapCat adapter.
// Upstream attribution and license are retained in LICENSES/Cyrene-Agent-MIT.txt.
import { createHash } from "node:crypto";
import { QQ_CONTRACT_LIMITS, validateInboundMessage } from "../contract";
import type { QqInboundMessageV1, QqMention, QqReply, QqSendRequestV1, QqMedia } from "../contract";
import { isBoundedJson } from "../contract/validation";
import type { OneBotMessageEvent, OneBotSegment } from "./onebot-types";

const MAX_SEGMENTS = 1024;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const TEXT_CHUNK_CODEPOINTS = 1500;
const MEDIA_TYPES = new Set(["image", "mface", "record", "file", "video"]);
const INVALID_MESSAGE = "Invalid OneBot message";
// Shared by all optional enrichment, not renewed for each segment/download.
export const INBOUND_NORMALIZATION_BUDGET_MS = 120_000;

type ActionClient = { call<T>(action: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> };
export interface OneBotNormalizerContext {
  selfId: string;
  connectionEpoch: number;
  configRevision: number;
  client: ActionClient;
  now?: () => number;
  actionTimeoutMs?: number;
  /** Test control only; the IPC entry point always uses the fixed budget. */
  normalizationBudgetMs?: number;
  /** Must apply deadline to the underlying request, including partial-stream cleanup. */
  resolveMedia?: (segment: OneBotSegment, eventId: string, deadline: number) => Promise<QqMedia>;
}

function invalid(): never { throw new Error(INVALID_MESSAGE); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function id(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) invalid();
  if (typeof value !== "string" && typeof value !== "number") invalid();
  const result = String(value);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result)) invalid();
  return result;
}
function boundedString(value: unknown, max = QQ_CONTRACT_LIMITS.maxTextLength): string {
  if (typeof value !== "string" || value.length > max) invalid();
  return value;
}
function optionalName(value: unknown): string | undefined {
  return value === undefined ? undefined : boundedString(value, 256).trim() || undefined;
}
function senderName(sender: Record<string, unknown>): string | undefined {
  // Validate both fields even when a nonempty card takes precedence.
  const card = optionalName(sender.card);
  const nickname = optionalName(sender.nickname);
  return card || nickname;
}
function nonnegativeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) invalid();
  return value as number;
}
function segmentText(segment: OneBotSegment): string {
  const value = segment.type === "markdown"
    ? segment.data.markdown === undefined ? segment.data.content : segment.data.markdown
    : segment.data.text;
  return boundedString(value === undefined ? "" : value);
}
function segments(value: unknown): OneBotSegment[] {
  if (!Array.isArray(value) || value.length > MAX_SEGMENTS) invalid();
  let mentionCount = 0;
  let textLength = 0;
  for (const segment of value) {
    if (!record(segment) || typeof segment.type !== "string"
      || !/^[A-Za-z0-9_-]{1,64}$/.test(segment.type) || !record(segment.data)) invalid();
    const typed = segment as unknown as OneBotSegment;
    if (segment.type === "text" || segment.type === "markdown") textLength += segmentText(typed).length;
    if (segment.type === "at") {
      id(segment.data.qq);
      if (++mentionCount > QQ_CONTRACT_LIMITS.maxMentions) invalid();
    }
    if (segment.type === "reply") id(segment.data.id);
    if (segment.type === "face" && segment.data.id !== undefined) id(segment.data.id);
  }
  if (textLength > QQ_CONTRACT_LIMITS.maxTextLength) invalid();
  return value as OneBotSegment[];
}

function route(event: Record<string, unknown>): QqInboundMessageV1["conversation"] {
  if (event.message_type === "private") return { type: "private", peerId: id(event.user_id) };
  if (event.message_type === "group") return { type: "group", groupId: id(event.group_id) };
  return invalid();
}

/** Stable identity only, shared by the early dedupe gate and full normalizer.
 * Route objects are rebuilt in canonical order, preserving existing event IDs. */
export function oneBotMessageEventId(event: OneBotMessageEvent, expectedSelfId: string): string {
  if (!record(event)) invalid();
  const selfId = id(expectedSelfId);
  if (id(event.self_id) !== selfId) invalid();
  return `onebot_${createHash("sha256").update(JSON.stringify([selfId, route(event), id(event.message_id)])).digest("hex")}`;
}

async function resolveMemberName(client: ActionClient, groupId: string, userId: string): Promise<string | undefined> {
  try {
    const data = await client.call<unknown>("get_group_member_info", { group_id: groupId, user_id: userId, no_cache: false });
    if (!isBoundedJson(data) || !record(data)) return undefined;
    return senderName(data);
  } catch {
    // Protocol errors may contain credentials or local paths. Never expose them.
    return undefined;
  }
}

async function resolveReply(client: ActionClient, messageId: string): Promise<QqReply> {
  const reply: QqReply = { messageId };
  try {
    const data = await client.call<unknown>("get_msg", { message_id: messageId });
    if (!isBoundedJson(data) || !record(data)) return reply;
    const resolved: QqReply = { messageId };
    if (data.sender !== undefined) {
      if (!record(data.sender)) return reply;
      if (data.sender.user_id !== undefined) resolved.senderId = id(data.sender.user_id);
      const name = senderName(data.sender);
      if (name) resolved.senderName = name;
    }
    if (data.message !== undefined) {
      // Extract only this message's text; never fetch nested reply/forward/media segments.
      resolved.text = segments(data.message)
        .filter((segment) => segment.type === "text" || segment.type === "markdown")
        .map(segmentText).join("").trim();
    }
    return resolved;
  } catch {
    return reply;
  }
}

export function messageMentionsSelf(event: Pick<OneBotMessageEvent, "message">, selfId: string): boolean {
  try {
    const target = id(selfId);
    if (!isBoundedJson(event.message)) return false;
    return segments(event.message).some((segment) => segment.type === "at" && id(segment.data.qq) === target);
  } catch { return false; }
}

/** Fail closed on malformed routes; this early filter does not replace host policy. */
export function isQqEventAllowed(
  event: Pick<OneBotMessageEvent, "message_type" | "user_id" | "group_id" | "message">,
  config: { allowedPrivateUserIds: string[]; allowedGroupIds: string[]; groupRequireMention: boolean },
  selfId: string,
): boolean {
  try {
    if (!isBoundedJson(event) || !record(event)) return false;
    const target = id(selfId);
    const userId = id(event.user_id);
    const conversation = route(event);
    const message = segments(event.message);
    if (conversation.type === "private") return config.allowedPrivateUserIds.includes(userId);
    if (!config.allowedGroupIds.includes(conversation.groupId)) return false;
    return !config.groupRequireMention
      || message.some((segment) => segment.type === "at" && id(segment.data.qq) === target);
  } catch { return false; }
}

export async function normalizeOneBotMessage(
  event: OneBotMessageEvent,
  context: OneBotNormalizerContext,
): Promise<QqInboundMessageV1> {
  const budget = context.normalizationBudgetMs ?? INBOUND_NORMALIZATION_BUDGET_MS;
  const actionTimeout = context.actionTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > INBOUND_NORMALIZATION_BUDGET_MS
    || !Number.isSafeInteger(actionTimeout) || actionTimeout < 1 || actionTimeout > 600_000) invalid();
  const deadline = performance.now() + budget;
  const client: ActionClient = { call: (action, params) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) return Promise.reject(new Error("Normalization timeout"));
    return context.client.call(action, params, Math.min(actionTimeout, remaining));
  } };
  if (!isBoundedJson(event) || !record(event) || event.post_type !== "message") invalid();
  const selfId = id(context.selfId);
  if (id(event.self_id) !== selfId) invalid();
  const conversation = route(event);
  const backendMessageId = id(event.message_id);
  const senderId = id(event.user_id);
  const connectionEpoch = nonnegativeInteger(context.connectionEpoch);
  const configRevision = nonnegativeInteger(context.configRevision);
  const timestampMs = event.time === undefined
    ? nonnegativeInteger((context.now ?? Date.now)(), MAX_TIMESTAMP_MS)
    : nonnegativeInteger(nonnegativeInteger(event.time) * 1000, MAX_TIMESTAMP_MS);
  let name: string | undefined;
  if (event.sender !== undefined) {
    if (!record(event.sender)) invalid();
    name = senderName(event.sender);
    if (event.sender.user_id !== undefined && id(event.sender.user_id) !== senderId) invalid();
  }
  // Validate every segment before making any enrichment calls.
  const message = segments(event.message);
  const eventId = oneBotMessageEventId(event, selfId);
  const attachments: QqMedia[] = [];
  let mediaAttempts = 0;
  const mentions: QqMention[] = [];
  const textParts: string[] = [];
  let reply: QqReply | undefined;
  let skippedFirstSelfMention = false;
  // Invocation-local, so no account, reconnection or group state can leak across events.
  const memberNames = new Map<string, Promise<string | undefined>>();
  for (const segment of message) {
    if (segment.type === "text" || segment.type === "markdown") {
      textParts.push(segmentText(segment));
    } else if (segment.type === "at") {
      const userId = id(segment.data.qq);
      let mentionName: string | undefined;
      if (userId === "all") mentionName = "全体成员";
      else if (conversation.type === "group") {
        if (!memberNames.has(userId)) memberNames.set(userId, resolveMemberName(client, conversation.groupId, userId));
        mentionName = await memberNames.get(userId);
      }
      mentions.push(mentionName ? { userId, name: mentionName } : { userId });
      if (userId === selfId && !skippedFirstSelfMention) skippedFirstSelfMention = true;
      else textParts.push(` @${mentionName || userId} `);
    } else if (segment.type === "reply") {
      if (!reply) reply = await resolveReply(client, id(segment.data.id));
    } else if (MEDIA_TYPES.has(segment.type)) {
      if (context.resolveMedia && mediaAttempts < QQ_CONTRACT_LIMITS.maxAttachments && deadline - performance.now() >= 1) {
        mediaAttempts++;
        try { attachments.push(await context.resolveMedia(segment, eventId, deadline)); }
        catch { textParts.push(`[附件不可用:${segment.type}]`); }
      } else textParts.push(`[附件${context.resolveMedia ? "不可用" : "未启用"}:${segment.type}]`);
    } else if (segment.type === "face") {
      textParts.push(`[QQ表情:${segment.data.id === undefined ? "" : id(segment.data.id)}]`);
    } else if (segment.type === "json") {
      textParts.push("[JSON卡片]");
    } else {
      textParts.push(`[未支持的消息类型:${segment.type}]`);
    }
  }
  const result: QqInboundMessageV1 = {
    eventId, backendMessageId, selfId, connectionEpoch, configRevision, conversation, senderId, timestampMs,
    // raw_message can contain CQ media paths and is deliberately never forwarded.
    text: textParts.join("").trim() || (attachments.length ? "" : "[空消息]"),
    ...(attachments.length ? { attachments } : {}),
    ...(name ? { senderName: name } : {}),
    ...(mentions.length ? { mentions } : {}),
    ...(reply ? { reply } : {}),
  };
  if (!validateInboundMessage(result)) invalid();
  return result;
}

export function splitQqText(text: string, maxCodepoints = TEXT_CHUNK_CODEPOINTS): string[] {
  if (!Number.isSafeInteger(maxCodepoints) || maxCodepoints <= 0) throw new Error("Invalid QQ text chunk size");
  const source = text.trim();
  if (!source) return [];
  const result: string[] = [];
  const codepoints = Array.from(source);
  let offset = 0;
  while (codepoints.length - offset > maxCodepoints) {
    let splitAt = maxCodepoints;
    for (let i = maxCodepoints - 1; i >= Math.floor(maxCodepoints * 0.55); i--) {
      if (/[。！？!?；;…\n]/u.test(codepoints[offset + i])) {
        splitAt = i + 1;
        break;
      }
    }
    const chunk = codepoints.slice(offset, offset + splitAt).join("").trim();
    if (chunk) result.push(chunk);
    offset += splitAt;
  }
  const tail = codepoints.slice(offset).join("").trim();
  if (tail) result.push(tail);
  return result;
}

/** Prefix only the first chunk of a group reply, matching the former adapter. */
export function textPayloads(
  part: { kind: "text"; text: string },
  replyContext?: QqSendRequestV1["replyContext"],
  isGroup = false,
): OneBotSegment[][] {
  boundedString(part.text);
  const payloads: OneBotSegment[][] = splitQqText(part.text)
    .map((text) => [{ type: "text", data: { text } }]);
  if (isGroup && replyContext && payloads.length) {
    const prefix: OneBotSegment[] = [{ type: "reply", data: { id: id(replyContext.messageId) } }];
    if (replyContext.mentionUserId !== undefined) {
      prefix.push({ type: "at", data: { qq: id(replyContext.mentionUserId) } }, { type: "text", data: { text: " " } });
    }
    payloads[0].unshift(...prefix);
  }
  return payloads;
}
