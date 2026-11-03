import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it, type Mock, vi } from "vitest";

import { isCompiledChannel } from "#channel/compiled-channel.js";
import { INACTIVE_REQUEST_NOTICE } from "#channel/inactive-prompt.js";
import { isHttpRouteDefinition } from "#channel/routes.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { renderInteractionComponents } from "#public/channels/discord/hitl.js";
import { discordChannel } from "#public/channels/discord/index.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyHex = Buffer.from(publicKey.export({ format: "der", type: "spki" }))
  .subarray(-32)
  .toString("hex");

const customId = (
  renderInteractionComponents({
    call: { callId: "call_1", input: {}, name: "ask_question" },
    interactionId: "call_1",
    request: {
      kind: "question",
      options: [{ id: "approve", label: "Approve" }],
      prompt: "Approve?",
    },
    status: "open",
    stepIndex: 0,
    turnId: "turn_0",
  })[0] as { components: Array<{ custom_id: string }> }
).components[0]!.custom_id;

const components = [
  {
    type: 1,
    components: [{ type: 2, custom_id: customId, label: "Approve", style: 1 }],
  },
];

/** A press of Approve in guild G01, as Discord sends it: the presser on `member`. */
function press(content: string | null = "Approve?", webhookId?: string, flags = 64): Request {
  const body = JSON.stringify({
    application_id: "APP1",
    channel_id: "C01",
    data: { component_type: 2, custom_id: customId },
    guild_id: "G01",
    id: "I-U01",
    member: { user: { id: "U01", username: "U01" } },
    message: {
      components,
      content,
      id: "M01",
      webhook_id: webhookId,
      flags: webhookId ? flags : undefined,
    },
    token: "tok2",
    type: 3,
    version: 1,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://example.com/eve/v1/discord", {
    body,
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString(
        "hex",
      ),
      "x-signature-timestamp": timestamp,
    },
    method: "POST",
  });
}

/** Posts `request` and exposes the response separately from its background work. */
async function firePost(
  channel: unknown,
  request: Request,
  send: Mock<(...args: any[]) => any>,
): Promise<{ response: Response; finished: Promise<unknown> }> {
  if (!isCompiledChannel(channel)) throw new Error("Expected a compiled channel.");
  const post = channel.routes.find((route) => route.method === "POST");
  if (!post || !isHttpRouteDefinition(post)) throw new Error("Expected a POST route.");
  const waitUntil = vi.fn();
  const response = await post.handler(request, {
    ...mockAgentRouteArgs(),
    attachSession: vi.fn() as never,
    ...mockChannelContext(send),
    to: vi.fn() as never,
    params: {},
    requestIp: null,
    waitUntil,
  });
  const pending = waitUntil.mock.calls.map(([task]) => task as Promise<unknown>);
  return { response, finished: Promise.all(pending) };
}

describe("discordChannel answer feedback", () => {
  const discordApi = (config: Parameters<typeof discordChannel>[0] = {}) => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json({ channel_id: "C01", id: "M02" }),
    );
    return {
      channel: discordChannel({
        api: { fetch: fetchMock as typeof fetch },
        credentials: { applicationId: "APP1", botToken: "bot-token", publicKey: publicKeyHex },
        ...config,
      }),
      calls: () =>
        fetchMock.mock.calls.map(([url, init]) => ({
          body: JSON.parse(String(init?.body)) as unknown,
          method: init?.method,
          url: String(url),
        })),
    };
  };
  const busy = {
    body: {
      allowed_mentions: { parse: [] },
      components: [
        {
          type: 1,
          components: [
            { type: 2, custom_id: customId, disabled: true, label: "Approving…", style: 2 },
          ],
        },
      ],
    },
    method: "PATCH",
    url: "https://discord.com/api/v10/channels/C01/messages/M01",
  };
  const feedback = (content: string) => ({
    body: { allowed_mentions: { parse: [] }, content },
    method: "PATCH",
    url: "https://discord.com/api/v10/webhooks/APP1/tok2/messages/@original",
  });
  const uncertainty = "I could not confirm your answer. It may already have been accepted.";
  const rejected = "Your answer could not be accepted. Please try again.";
  const received = feedback("Answer received.");
  const clear = { ...busy, body: { allowed_mentions: { parse: [] }, components: [] } };

  it("keeps Discord's private loading response while authorization is pending", async () => {
    const answer = Promise.withResolvers<null>();
    const onAnswers = vi.fn(() => answer.promise);
    const { channel, calls } = discordApi({ onAnswers });
    const send = vi.fn();
    const request = press();

    const posted = await firePost(channel, request, send);
    const acknowledgement = await posted.response.json();
    const pendingCalls = calls();
    expect(acknowledgement).toEqual({ type: 5, data: { flags: 64 } });
    expect(pendingCalls).toEqual([]);
    expect(onAnswers).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();

    answer.resolve(null);
    await posted.finished;
    const requests = calls();
    const dropped = feedback("This answer was not accepted.");
    expect(requests).toEqual([dropped]);
  });

  it("does not dispatch an answer before Discord commits the busy update", async () => {
    const edit = Promise.withResolvers<Response>();
    const fetchMock = vi.fn(() => edit.promise);
    const { channel } = discordApi({ api: { fetch: fetchMock as typeof fetch } });
    const send = vi.fn();
    const delivery = {
      deliveryId: "D01",
      async *stream() {
        yield { type: "delivery.settled", data: { deliveryId: "D01", outcome: "applied" } };
      },
    };
    send.mockResolvedValue(delivery);
    const request = press();

    const posted = await firePost(channel, request, send);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });
    expect(send).not.toHaveBeenCalled();

    const response = Response.json({ id: "M01" });
    edit.resolve(response);
    await posted.finished;
    expect(send).toHaveBeenCalledOnce();
  });

  it("retires the pressed prompt and completes the private loading response", async () => {
    captureLogRecords();
    const { channel, calls } = discordApi();
    const request = press();
    const send = vi.fn();
    const error = new SessionNotActiveError();
    send.mockRejectedValue(error);

    const posted = await firePost(channel, request, send);
    await posted.finished;

    const requests = calls();
    const inactive = feedback(INACTIVE_REQUEST_NOTICE);
    expect(requests).toEqual([
      busy,
      {
        ...busy,
        body: {
          allowed_mentions: { parse: [] },
          components: [],
          content: "Approve?\n\nNo longer active",
        },
      },
      inactive,
    ]);
  });

  it("clears the busy controls when the press carries no prompt to keep", async () => {
    captureLogRecords();
    const { channel, calls } = discordApi();
    const request = press(null);
    const send = vi.fn();
    const error = new SessionNotActiveError();
    send.mockRejectedValue(error);

    const posted = await firePost(channel, request, send);
    await posted.finished;

    const requests = calls();
    const inactive = feedback(INACTIVE_REQUEST_NOTICE);
    expect(requests).toEqual([busy, clear, inactive]);
  });

  it("reports an admission error without restoring possibly settled controls", async () => {
    captureLogRecords();
    const { channel, calls } = discordApi();
    const request = press();
    const send = vi.fn();
    const error = new Error("Delivery connection disconnected");
    send.mockRejectedValue(error);

    const posted = await firePost(channel, request, send);
    await posted.finished;

    const requests = calls();
    const failed = feedback(uncertainty);
    expect(requests).toEqual([busy, failed]);
  });

  it("reports an authorization failure without editing shared controls", async () => {
    captureLogRecords();
    const { channel, calls } = discordApi({
      onAnswers: () => {
        throw new Error("boom");
      },
    });
    const request = press();
    const send = vi.fn();

    const posted = await firePost(channel, request, send);
    await posted.finished;

    const requests = calls();
    const failed = feedback(rejected);
    expect(requests).toEqual([failed]);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the busy controls after admission while the request settles", async () => {
    const settled = Promise.withResolvers<void>();
    const delivery = {
      deliveryId: "D01",
      async *stream() {
        await settled.promise;
        yield { type: "delivery.settled", data: { deliveryId: "D01", outcome: "applied" } };
      },
    };
    const { channel, calls } = discordApi();
    const send = vi.fn();
    send.mockResolvedValue(delivery);
    const request = press();

    const posted = await firePost(channel, request, send);
    await vi.waitFor(() => {
      const requests = calls();
      expect(requests).toHaveLength(2);
    });
    const pendingCalls = calls();
    expect(pendingCalls).toEqual([busy, received]);

    settled.resolve();
    await posted.finished;
    const finishedCalls = calls();
    expect(finishedCalls).toEqual([busy, received]);
  });

  it("does not deliver an answer if the busy update fails", async () => {
    captureLogRecords();
    const fetchMock = vi.fn(async (url: unknown) => {
      const address = String(url);
      if (address.includes("/channels/")) return new Response(null, { status: 500 });
      return Response.json({ id: "M02" });
    });
    const { channel } = discordApi({ api: { fetch: fetchMock as typeof fetch } });
    const request = press();
    const send = vi.fn();

    const posted = await firePost(channel, request, send);
    await posted.finished;

    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("edits an ephemeral source through its webhook using the fresh answer token", async () => {
    const delivery = {
      deliveryId: "D01",
      async *stream() {
        yield { type: "delivery.settled", data: { deliveryId: "D01", outcome: "applied" } };
      },
    };
    const { channel, calls } = discordApi();
    const send = vi.fn();
    send.mockResolvedValue(delivery);
    const request = press("Approve?", "APP1");

    const posted = await firePost(channel, request, send);
    await posted.finished;

    const requests = calls();
    expect(requests).toEqual([
      { ...busy, url: "https://discord.com/api/v10/webhooks/APP1/tok2/messages/M01" },
      received,
    ]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("uses bot auth for public interaction prompts so token expiry cannot block edits", async () => {
    const delivery = {
      deliveryId: "D01",
      async *stream() {
        yield { type: "delivery.settled", data: { deliveryId: "D01", outcome: "applied" } };
      },
    };
    const { channel, calls } = discordApi();
    const send = vi.fn();
    send.mockResolvedValue(delivery);
    const request = press("Approve?", "APP1", 0);

    const posted = await firePost(channel, request, send);
    await posted.finished;

    const requests = calls();
    expect(requests).toEqual([busy, received]);
  });

  it("does not restore old controls when confirmation fails after admission", async () => {
    captureLogRecords();
    const delivery = {
      deliveryId: "D01",
      async *stream() {
        yield { type: "response.submitted", data: { deliveryId: "D01", responseId: "R01" } };
        throw new Error("Confirmation stream disconnected");
      },
    };
    const { channel, calls } = discordApi();
    const send = vi.fn();
    send.mockResolvedValue(delivery);
    const request = press();

    const posted = await firePost(channel, request, send);
    await posted.finished;

    const requests = calls();
    const failed = feedback(uncertainty);
    expect(requests).toEqual([busy, received, failed]);
  });

  for (const outcome of ["refused", "failed"]) {
    it(`privately reports a ${outcome} response to its responder`, async () => {
      const delivery = {
        deliveryId: "D01",
        async *stream() {
          yield { type: "response.submitted", data: { deliveryId: "D01", responseId: "R01" } };
          yield { type: "response.settled", data: { responseId: "R01", outcome } };
        },
      };
      const { channel, calls } = discordApi();
      const send = vi.fn();
      send.mockResolvedValue(delivery);
      const request = press();

      const posted = await firePost(channel, request, send);
      await posted.finished;

      const requests = calls();
      const failed = feedback(rejected);
      expect(requests).toEqual([busy, received, failed]);
    });
  }

  it("clears the busy controls when an already settled request ignores the answer", async () => {
    const delivery = {
      deliveryId: "D01",
      async *stream() {
        yield { type: "delivery.settled", data: { deliveryId: "D01", outcome: "ignored" } };
      },
    };
    const { channel, calls } = discordApi();
    const send = vi.fn();
    send.mockResolvedValue(delivery);
    const request = press();

    const posted = await firePost(channel, request, send);
    await posted.finished;

    const requests = calls();
    expect(requests).toEqual([busy, received, clear]);
  });
});
