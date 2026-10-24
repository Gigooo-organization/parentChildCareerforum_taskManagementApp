import { describe, expect, it } from "vite-plus/test";
import { parseJobs } from "./jobs";

const job = {
  id: "45607d46-4f79-45cb-b085-56207d46b371",
  prompt: "見出しを変えて",
  status: "pending",
  message: "スタッフの確認を待っています。",
};

describe("AI job snapshots", () => {
  it("accepts every status and returns a copy", () => {
    const statuses = [
      "pending",
      "queued",
      "running",
      "succeeded",
      "failed",
      "timed_out",
      "cancelled",
    ];
    for (const status of statuses) {
      const input = [{ ...job, status }];
      expect(parseJobs(input)).toEqual(input);
      expect(parseJobs(input)[0]).not.toBe(input[0]);
    }
    expect(parseJobs([])).toEqual([]);
  });
  it.each([
    null,
    {},
    [null],
    [{ ...job, id: "../../reset" }],
    [{ ...job, status: "approved" }],
    [{ ...job, prompt: "" }],
    [{ ...job, prompt: "x".repeat(1001) }],
    [{ ...job, message: "x".repeat(501) }],
    Array.from({ length: 31 }, () => job),
    [job, job],
  ])("rejects malformed snapshots %#", (input) => {
    expect(() => parseJobs(input)).toThrow();
  });
});
