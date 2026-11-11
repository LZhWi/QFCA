import { describe, expect, it, vi } from "vitest";
import { QQ_CONTRACT_LIMITS, validateInboundMessage } from "../contract";
import { isQqEventAllowed, messageMentionsSelf, normalizeOneBotMessage, oneBotMessageEventId, splitQqText, textPayloads } from "./codec";
import type { OneBotNormalizerContext } from "./codec";
import type { OneBotMessageEvent } from "./onebot-types";

function event(overrides: Partial<OneBotMessageEvent> = {}): OneBotMessageEvent {
  return {
    time: 1_700_000_000,
    self_id: "9000",
    post_type: "message",
    message_type: "private",
    message_id: "m-1",
    user_id: "1000",
    message: [{ type: "text", data: { text: "你好" } }],
    ...overrides,
  };
}
function context(
  handler: (action: string, params?: Record<string, unknown>) => unknown | Promise<unknown> = () => ({}),
  overrides: Partial<OneBotNormalizerContext> = {},
): OneBotNormalizerContext {
  const call = vi.fn(async (action: string, params?: Record<string, unknown>) => handler(action, params));
  return {
    selfId: "9000", connectionEpoch: 3, configRevision: 5, now: () => 1_800_000_000_000,
    client: { call: call as OneBotNormalizerContext["client"]["call"] },
    ...overrides,
  };
}
function unchecked(value: unknown): OneBotMessageEvent { return value as OneBotMessageEvent; }

const policy = { allowedPrivateUserIds: ["1000"], allowedGroupIds: ["2000"], groupRequireMention: true };

describe("normalizeOneBotMessage", () => {
  it("preserves segment order, strips the first self mention, and expands one reply", async () => {
    const input = event({
      message_type: "group", group_id: "2000", sender: { user_id: "1000", nickname: "小明", card: "群名片" },
      message: [
        { type: "at", data: { qq: "9000" } },
        { type: "text", data: { text: "先看" } },
        { type: "at", data: { qq: "3000" } },
        { type: "text", data: { text: "的图" } },
        { type: "reply", data: { id: "old-1" } },
        { type: "image", data: { file: "img-1" } },
      ],
    });
    const ctx = context((action) => action === "get_msg"
      ? { sender: { user_id: "4000", nickname: "引用者" }, message: [{ type: "text", data: { text: "旧消息" } }] }
      : { card: "被提及者" });
    const result = await normalizeOneBotMessage(input, ctx);
    expect(messageMentionsSelf(input, "9000")).toBe(true);
    expect(result).toMatchObject({
      backendMessageId: "m-1", selfId: "9000", connectionEpoch: 3, configRevision: 5,
      conversation: { type: "group", groupId: "2000" },
      senderId: "1000", senderName: "群名片", timestampMs: 1_700_000_000_000,
      reply: { messageId: "old-1", senderId: "4000", senderName: "引用者", text: "旧消息" },
      mentions: [{ userId: "9000", name: "被提及者" }, { userId: "3000", name: "被提及者" }],
    });
    expect(result.text).toBe("先看 @被提及者 的图[附件未启用:image]");
    expect(result).not.toHaveProperty("attachments");
    expect(result.mentions?.[0]).not.toHaveProperty("isBot");
    expect(validateInboundMessage(result)).toBe(true);
  });

  it("retains subsequent self mentions and @all, caches only within one invocation", async () => {
    const input = event({ message_type: "group", group_id: 2000, message: [
      { type: "at", data: { qq: 9000 } },
      { type: "text", data: { text: "请看" } },
      { type: "at", data: { qq: "9000" } },
      { type: "at", data: { qq: "all" } },
    ] });
    const ctx = context(() => ({ card: "机器人" }));
    const result = await normalizeOneBotMessage(input, ctx);
    expect(result.text).toBe("请看 @机器人  @全体成员");
    expect(result.mentions).toEqual([
      { userId: "9000", name: "机器人" }, { userId: "9000", name: "机器人" }, { userId: "all", name: "全体成员" },
    ]);
    expect(ctx.client.call).toHaveBeenCalledTimes(1);
    expect(ctx.client.call).toHaveBeenCalledWith("get_group_member_info", { group_id: "2000", user_id: "9000", no_cache: false });
    const nextContext = context(() => ({ nickname: "新账号昵称" }), { selfId: "8000" });
    const next = await normalizeOneBotMessage({ ...input, self_id: "8000" }, nextContext);
    expect(next.text).toContain("@新账号昵称");
    expect(nextContext.client.call).toHaveBeenCalledTimes(1);
  });

  it("falls back to the mention ID when enrichment fails, without exposing the error", async () => {
    const input = event({ message_type: "group", group_id: "2000", message: [{ type: "at", data: { qq: "3000" } }] });
    const result = await normalizeOneBotMessage(input, context(() => { throw new Error("secret-token /home/private"); }));
    expect(result.text).toBe("@3000");
    expect(result.mentions).toEqual([{ userId: "3000" }]);
    expect(JSON.stringify(result)).not.toMatch(/secret-token|home/);
  });

  it("handles markdown, faces, cards and unknown segments with explicit placeholders", async () => {
    const input = event({ message: [
      { type: "markdown", data: { markdown: "看看" } },
      { type: "markdown", data: { content: "这个" } },
      { type: "face", data: { id: 123 } },
      { type: "json", data: { data: '{"token":"secret"}' } },
      { type: "location", data: { lat: "31.2", lng: "121.4" } },
      { type: "forward", data: { id: "fwd-1" } },
    ] });
    const result = await normalizeOneBotMessage(input, context());
    expect(result.text).toBe("看看这个[QQ表情:123][JSON卡片][未支持的消息类型:location][未支持的消息类型:forward]");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("does not fetch media or expose raw events, paths, credentials, or host fields", async () => {
    const input = unchecked({ ...event(), channel: "admin", _raw: { token: "private-token" }, trusted: true,
      raw_message: "[CQ:file,file=/host/private/token]", sender: { nickname: "小明", filePath: "/host/sender" },
      message: ["image", "mface", "record", "file", "video"].map((type) => ({
        type, data: { file: "/host/private/file", url: "http://localhost/?token=private-token", filePath: "/host/private" },
      })),
    });
    const ctx = context();
    const result = await normalizeOneBotMessage(input, ctx);
    expect(result.text).toBe("[附件未启用:image][附件未启用:mface][附件未启用:record][附件未启用:file][附件未启用:video]");
    expect(ctx.client.call).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("attachments");
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/private-token|localhost|host\/|filePath|_raw|channel|trusted/);
    expect(JSON.parse(json)).toEqual(result);
    expect(validateInboundMessage(result)).toBe(true);
  });

  it("never restores raw CQ data after stripping a lone self mention", async () => {
    const result = await normalizeOneBotMessage(event({
      message: [{ type: "at", data: { qq: "9000" } }], raw_message: "[CQ:at,qq=9000][CQ:image,file=/private/path]",
    }), context());
    expect(result.text).toBe("[空消息]");
    expect(result).not.toHaveProperty("senderName");
    expect(result).not.toHaveProperty("reply");
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("expands just the first reply and never follows nested replies or media", async () => {
    const input = event({ message: [
      { type: "reply", data: { id: "old-1" } }, { type: "reply", data: { id: "old-2" } },
    ] });
    const ctx = context(() => ({ sender: { user_id: 4000, card: "引用者", filePath: "/private/sender" }, message: [
      { type: "text", data: { text: "一" } },
      { type: "reply", data: { id: "nested-1" } },
      { type: "image", data: { file: "/private/image" } },
      { type: "markdown", data: { content: "层" } },
    ], raw_message: "private raw", _raw: "private raw" }));
    const result = await normalizeOneBotMessage(input, ctx);
    expect(result.reply).toEqual({ messageId: "old-1", senderId: "4000", senderName: "引用者", text: "一层" });
    expect(ctx.client.call).toHaveBeenCalledTimes(1);
    expect(ctx.client.call).toHaveBeenCalledWith("get_msg", { message_id: "old-1" });
  });

  it.each([
    () => { throw new Error("private detail"); },
    () => ({ sender: { user_id: "/invalid/path" }, message: [] }),
    () => ({ sender: { nickname: "x".repeat(257) }, message: [] }),
    () => ({ message: [{ type: "text", data: { text: {} } }] }),
  ])("preserves only the reply ID when enrichment is unavailable or malformed", async (handler) => {
    const result = await normalizeOneBotMessage(event({ message: [{ type: "reply", data: { id: "old-1" } }] }), context(handler));
    expect(result.reply).toEqual({ messageId: "old-1" });
  });

  it("uses a stable bounded hash scoped to account, conversation and message ID", async () => {
    const ctx = context();
    const original = await normalizeOneBotMessage(event(), ctx);
    const repeat = await normalizeOneBotMessage(event(), { ...ctx, connectionEpoch: 4, configRevision: 8 });
    const differentPeer = await normalizeOneBotMessage(event({ user_id: "1001" }), ctx);
    const group = await normalizeOneBotMessage(event({ message_type: "group", group_id: "1000" }), ctx);
    const differentAccount = await normalizeOneBotMessage(event({ self_id: "8000" }), { ...ctx, selfId: "8000" });
    const differentMessage = await normalizeOneBotMessage(event({ message_id: "m-2" }), ctx);
    expect(original.eventId).toMatch(/^onebot_[a-f0-9]{64}$/);
    // Pin the pre-media-review identity format so history dedupe stays stable.
    expect(original.eventId).toBe('onebot_252ac179f3005f38727cd5722f442757c0b265e8d4d6532027828d43bf7d8546');
    expect(oneBotMessageEventId(event(), ctx.selfId)).toBe(original.eventId);
    expect(repeat.eventId).toBe(original.eventId);
    expect(new Set([original, differentPeer, group, differentAccount, differentMessage].map((item) => item.eventId)).size).toBe(5);
  });

  it("uses the supplied clock only for missing time, and preserves timestamp zero", async () => {
    const noTime = event();
    delete noTime.time;
    expect((await normalizeOneBotMessage(noTime, context())).timestampMs).toBe(1_800_000_000_000);
    expect((await normalizeOneBotMessage(event({ time: 0 }), context())).timestampMs).toBe(0);
  });

  it.each([
    { message_type: "unknown" }, { message_type: null }, { message_type: "group" },
    { message_type: "group", group_id: "" }, { message_type: "group", group_id: "/private/path" },
    { message_id: "" }, { message_id: "x".repeat(129) }, { message_id: Number.MAX_SAFE_INTEGER + 1 },
    { user_id: null }, { user_id: {} }, { self_id: "8000" }, { post_type: "message_sent" },
    { time: -1 }, { time: 1.5 }, { time: Number.NaN }, { time: 8_640_000_000_001 },
    { sender: { card: "x".repeat(257) } }, { sender: { user_id: "9999" } },
    { message: null }, { message: [null] }, { message: [{ type: "at", data: {} }] },
    { message: [{ type: "reply", data: { id: "../secret" } }] },
    { message: [{ type: "text", data: { text: {} } }] }, { message: [{ type: "text", data: { text: null } }] },
    { message: [{ type: "markdown", data: { markdown: null } }] }, { message: [{ type: "image", data: null }] },
    { message: [{ type: "/private/path", data: {} }] },
    { message: [{ type: "text", data: { text: "x".repeat(QQ_CONTRACT_LIMITS.maxTextLength + 1) } }] },
    { message: Array.from({ length: 65 }, () => ({ type: "at", data: { qq: "9000" } })) },
    { message: Array.from({ length: 1025 }, () => ({ type: "face", data: {} })) },
  ])("rejects malformed inbound data before performing enrichment: %j", async (overrides) => {
    const ctx = context();
    await expect(normalizeOneBotMessage(unchecked({ ...event(), ...overrides }), ctx)).rejects.toThrow("Invalid OneBot message");
    expect(ctx.client.call).not.toHaveBeenCalled();
  });

  it("rejects aggregate text limits, invalid context, and non-JSON source objects", async () => {
    const input = event({ message: [
      { type: "text", data: { text: "x".repeat(QQ_CONTRACT_LIMITS.maxTextLength) } },
      { type: "json", data: {} },
    ] });
    await expect(normalizeOneBotMessage(input, context())).rejects.toThrow("Invalid OneBot message");
    for (const overrides of [{ connectionEpoch: -1 }, { configRevision: 1.5 }, { selfId: "" }]) {
      await expect(normalizeOneBotMessage(event(), context(() => ({}), overrides))).rejects.toThrow("Invalid OneBot message");
    }
    const getter = vi.fn(() => "secret");
    const withAccessor = event();
    Object.defineProperty(withAccessor, "raw_message", { get: getter, enumerable: true });
    await expect(normalizeOneBotMessage(withAccessor, context())).rejects.toThrow("Invalid OneBot message");
    expect(getter).not.toHaveBeenCalled();
    await expect(normalizeOneBotMessage(unchecked({ ...event(), raw_message: undefined }), context())).rejects.toThrow("Invalid OneBot message");
  });
});

describe("isQqEventAllowed", () => {
  it("requires the private allowlist or group allowlist and self mention", () => {
    expect(isQqEventAllowed(event(), policy, "9000")).toBe(true);
    expect(isQqEventAllowed(event({ user_id: "1001" }), policy, "9000")).toBe(false);
    const group = event({ message_type: "group", group_id: "2000" });
    expect(isQqEventAllowed(group, policy, "9000")).toBe(false);
    expect(isQqEventAllowed({ ...group, message: [{ type: "at", data: { qq: 9000 } }] }, policy, "9000")).toBe(true);
    expect(isQqEventAllowed({ ...group, group_id: "2001", message: [{ type: "at", data: { qq: 9000 } }] }, policy, "9000")).toBe(false);
    expect(isQqEventAllowed(group, { ...policy, groupRequireMention: false }, "9000")).toBe(true);
    expect(isQqEventAllowed({ ...group, message: [{ type: "at", data: { qq: "all" } }] }, policy, "9000")).toBe(false);
  });

  it.each([
    { message_type: undefined }, { message_type: "unknown" }, { message_type: "group" },
    { message_type: "group", group_id: "" }, { user_id: Number.NaN }, { message: [null] },
    { message: [{ type: "at", data: null }] }, { message: [{ type: "at", data: {} }] },
  ])("fails closed for malformed routes or segments: %j", (overrides) => {
    expect(isQqEventAllowed(unchecked({ ...event(), ...overrides }), policy, "9000")).toBe(false);
  });
});

describe("splitQqText and textPayloads", () => {
  it("splits long Unicode text without breaking surrogate pairs", () => {
    const text = `${"昔".repeat(1499)}。${"🌸".repeat(10)}`;
    const chunks = splitQqText(text);
    expect(chunks).toHaveLength(2);
    expect(Array.from(chunks[0])).toHaveLength(1500);
    expect(chunks.join("")).toBe(text);
    expect(splitQqText("🌸🌸", 1)).toEqual(["🌸", "🌸"]);
  });
  it("prefers punctuation in the latter part of a chunk and trims empty text", () => {
    expect(splitQqText("123456。789012", 10)).toEqual(["123456。", "789012"]);
    expect(splitQqText("123456\n789012", 10)).toEqual(["123456", "789012"]);
    expect(splitQqText("123。456789012", 10)).toEqual(["123。456789", "012"]);
    expect(splitQqText("  \n  ")).toEqual([]);
    expect(splitQqText(" hi ")).toEqual(["hi"]);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid chunk limits: %s", (limit) => {
    expect(() => splitQqText("text", limit)).toThrow("Invalid QQ text chunk size");
  });
  it("prefixes only the first group chunk with reply and mention segments", () => {
    const text = "昔".repeat(1501);
    const result = textPayloads({ kind: "text", text }, { messageId: "old-1", mentionUserId: "1000" }, true);
    expect(result).toEqual([
      [{ type: "reply", data: { id: "old-1" } }, { type: "at", data: { qq: "1000" } },
        { type: "text", data: { text: " " } }, { type: "text", data: { text: "昔".repeat(1500) } }],
      [{ type: "text", data: { text: "昔" } }],
    ]);
    expect(textPayloads({ kind: "text", text: "hello" }, { messageId: "old-1" }, true)).toEqual([
      [{ type: "reply", data: { id: "old-1" } }, { type: "text", data: { text: "hello" } }],
    ]);
  });
  it("does not add reply prefixes to private or empty messages", () => {
    expect(textPayloads({ kind: "text", text: "hello" }, { messageId: "old-1", mentionUserId: "1000" }, false))
      .toEqual([[{ type: "text", data: { text: "hello" } }]]);
    expect(textPayloads({ kind: "text", text: " " }, { messageId: "old-1" }, true)).toEqual([]);
    expect(() => textPayloads({ kind: "text", text: "hello" }, { messageId: "../secret" }, true)).toThrow("Invalid OneBot message");
  });
});
