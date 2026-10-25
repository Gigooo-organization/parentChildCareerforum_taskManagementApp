import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createHearingAssessor, hearingUnavailable } from "./hearing";

const fetchMock = vi.fn<typeof fetch>();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const answer = (choice: "ready" | "needs_hearing" = "ready") => ({
  answers: {
    hearing: {
      type: "choice",
      choice,
      confidence: 0.55,
      probabilities:
        choice === "ready"
          ? { ready: 0.7759, needs_hearing: 0.2241 }
          : { ready: 0.2, needs_hearing: 0.8 },
    },
  },
});
function setup() {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  return createHearingAssessor("test-only-key");
}

describe("Clef hearing decisions", () => {
  it.each(["ready", "needs_hearing"] as const)(
    "parses %s without an invented probability threshold",
    async (choice) => {
      const assess = setup();
      fetchMock.mockResolvedValue(Response.json(answer(choice)));
      expect(await assess("タスク1つで10ポイント", new AbortController().signal)).toBe(
        choice === "ready" ? "ready" : "required",
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "https://openrouter.ai/api/alpha/decisions",
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: "Bearer test-only-key", "Content-Type": "application/json" },
        }),
      );
      const request = fetchMock.mock.calls[0]?.[1];
      expect(JSON.parse(String(request?.body))).toMatchObject({
        model: "cloudflare/clef-flash",
        state: { request: "タスク1つで10ポイント" },
        questions: {
          hearing: {
            type: "choice",
            criteria: { ready: expect.any(String), needs_hearing: expect.any(String) },
          },
        },
      });
    },
  );
  it.each([
    {},
    { answers: { hearing: { type: "choice", choice: "other" } } },
    { answers: { hearing: { ...answer().answers.hearing, confidence: 2 } } },
    {
      answers: {
        hearing: { ...answer().answers.hearing, probabilities: { ready: 0.2, needs_hearing: 0.8 } },
      },
    },
    {
      answers: {
        hearing: { ...answer().answers.hearing, probabilities: { ready: 1, needs_hearing: 1 } },
      },
    },
  ])("blocks malformed or inconsistent remote answer %#", async (body) => {
    const assess = setup();
    fetchMock.mockResolvedValue(Response.json(body));
    await expect(assess("変更して", new AbortController().signal)).rejects.toThrow(
      hearingUnavailable,
    );
  });
  it("sanitizes remote errors, invalid JSON and missing key", async () => {
    const assess = setup();
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { message: "secret-provider-error" } }, { status: 401 }),
    );
    await expect(assess("変更して", new AbortController().signal)).rejects.toThrow(
      hearingUnavailable,
    );
    fetchMock.mockResolvedValueOnce(new Response("not JSON"));
    await expect(assess("変更して", new AbortController().signal)).rejects.toThrow(
      hearingUnavailable,
    );
    fetchMock.mockClear();
    await expect(
      createHearingAssessor(undefined)("変更して", new AbortController().signal),
    ).rejects.toThrow(hearingUnavailable);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("combines caller cancellation with the bounded request timeout", async () => {
    const assess = setup();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockImplementation(async (_url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("no signal");
      signal.throwIfAborted();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const controller = new AbortController();
    const pending = assess("変更して", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(timeout).toHaveBeenCalledWith(15_000);
    timeout.mockReturnValueOnce(AbortSignal.abort(new DOMException("timeout", "TimeoutError")));
    await expect(assess("変更して", new AbortController().signal)).rejects.toThrow(
      hearingUnavailable,
    );
  });
});
