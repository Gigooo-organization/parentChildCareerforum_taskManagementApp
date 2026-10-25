import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createRenderer } from "vue";
import type { Job } from "@booth-shared/jobs";
import { useBoothJobs } from "./useBoothJobs";

const renderer = createRenderer<object, object>({
  patchProp() {},
  insert() {},
  remove() {},
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  setText() {},
  setElementText() {},
  parentNode: () => null,
  nextSibling: () => null,
});

class Events {
  static current: Events | undefined;
  onerror: (() => void) | undefined;
  close = vi.fn();
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  constructor(readonly url: string) {
    Events.current = this;
  }
  addEventListener(name: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(name, listener);
  }
  publish(jobs: Job[]) {
    this.listeners.get("jobs")?.(new MessageEvent("jobs", { data: JSON.stringify(jobs) }));
  }
}

const fetchMock = vi.fn<typeof fetch>();
const disposals = new Set<() => void>();
const draft: Job = {
  id: "00000000-0000-4000-8000-000000000001",
  prompt: "見出しを変えて",
  status: "draft",
  message: "カードを追加しました。",
};

function mount() {
  const captured: { state?: ReturnType<typeof useBoothJobs> } = {};
  const changed = vi.fn();
  const reset = vi.fn();
  const app = renderer.createApp({
    setup() {
      captured.state = useBoothJobs({ changed, reset });
      return () => null;
    },
  });
  app.mount({});
  const state = captured.state;
  const events = Events.current;
  if (!state || !events) throw new Error("Composable did not mount");
  const unmount = () => {
    if (disposals.delete(unmount)) app.unmount();
  };
  disposals.add(unmount);
  events.publish([]);
  return { state, events, changed, reset, unmount };
}

beforeEach(() => {
  fetchMock.mockReset();
  Events.current = undefined;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Events);
});
afterEach(() => {
  for (const dispose of disposals) dispose();
  vi.unstubAllGlobals();
});

describe("idea card client flow", () => {
  it("adds a draft without automatically requesting or approving a build", async () => {
    const { state, events, changed } = mount();
    fetchMock.mockResolvedValueOnce(Response.json(draft, { status: 201 }));
    state.prompt.value = "  見出しを変えて  ";
    expect(await state.submit()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prompt: draft.prompt }),
      }),
    );
    expect(state.jobs.value).toEqual([draft]);
    expect(state.prompt.value).toBe("");
    expect(changed).not.toHaveBeenCalled();
    expect(events.url).toBe("/api/events");
  });

  it("requests staff review only when the card is explicitly built", async () => {
    const { state, events } = mount();
    events.publish([draft]);
    fetchMock.mockResolvedValueOnce(Response.json({ ...draft, status: "pending" }));
    expect(await state.requestBuild(draft)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/chat/${draft.id}/request`,
      expect.objectContaining({ body: "{}" }),
    );
    events.publish([{ ...draft, status: "pending" }]);
    expect(state.jobs.value[0]?.status).toBe("pending");
    expect(state.notice.value).toContain("スタッフ");
  });

  it("refreshes the app once for a new completed job and clears the participant on reset", async () => {
    const { state, events, changed, reset } = mount();
    events.publish([{ ...draft, status: "running" }]);
    expect(changed).not.toHaveBeenCalled();
    events.publish([{ ...draft, status: "succeeded" }]);
    events.publish([{ ...draft, status: "succeeded" }]);
    expect(changed).toHaveBeenCalledTimes(1);
    state.prompt.value = "次の依頼";
    fetchMock.mockResolvedValueOnce(Response.json({}));
    expect(await state.reset()).toBe(true);
    expect(state.jobs.value).toEqual([]);
    expect(state.prompt.value).toBe("");
    expect(reset).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/reset", expect.objectContaining({ body: "{}" }));
  });

  it("keeps input and cards when submission fails and releases the busy state", async () => {
    const { state, events } = mount();
    events.publish([draft]);
    state.prompt.value = "新しいアイデア";
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "リセットしてください。" }, { status: 400 }),
    );
    expect(await state.submit()).toBe(false);
    expect(state.error.value).toBe("リセットしてください。");
    expect(state.prompt.value).toBe("新しいアイデア");
    expect(state.jobs.value).toEqual([draft]);
    expect(state.requestBusy.value).toBe(false);
  });

  it("closes the event stream and aborts a pending request on unmount without a visible error", async () => {
    const { state, events, unmount } = mount();
    fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    state.prompt.value = draft.prompt;
    const pending = state.submit();
    expect(state.requestBusy.value).toBe(true);
    unmount();
    expect(await pending).toBe(false);
    expect(events.close).toHaveBeenCalledTimes(1);
    expect(state.error.value).toBe("");
    expect(state.requestBusy.value).toBe(false);
  });
});
