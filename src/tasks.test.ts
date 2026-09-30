import { describe, expect, it } from "vitest";
import { createTaskRegistry, toTaskStatusResponse } from "./tasks.mjs";

describe("createTaskRegistry", () => {
  it("starts a task pending, at the back of the queue", () => {
    const reg = createTaskRegistry();
    reg.create("a");
    reg.create("b");

    expect(reg.get("a")?.status).toBe("pending");
    expect(reg.positionOf("a")).toBe(0);
    expect(reg.positionOf("b")).toBe(1);
  });

  it("takes a task out of the queue once it starts", () => {
    const reg = createTaskRegistry();
    reg.create("a");
    reg.create("b");
    reg.setStarted("a");

    expect(reg.get("a")?.status).toBe("started");
    // b is now first in line.
    expect(reg.positionOf("b")).toBe(0);
    expect(reg.positionOf("a")).toBe(0);
  });

  it("keeps the result of a task that succeeded", () => {
    const reg = createTaskRegistry();
    reg.create("a");
    reg.succeed("a", { document: { md_content: "# x" } });

    const task = reg.get("a");
    expect(task?.status).toBe("success");
    expect(task?.result).toEqual({ document: { md_content: "# x" } });
  });

  it("keeps why a task failed, and its status code", () => {
    const reg = createTaskRegistry();
    reg.create("a");
    reg.fail("a", { status: 415, body: { error: "UNSUPPORTED_FORMAT" } });

    const task = reg.get("a");
    expect(task?.status).toBe("failure");
    expect(task?.error).toEqual({ status: 415, body: { error: "UNSUPPORTED_FORMAT" } });
  });

  it("is silent about a task it never had", () => {
    expect(createTaskRegistry().get("nope")).toBeUndefined();
  });

  // Finished tasks linger so a poller can read the result, then go. An
  // unbounded map on a long-lived service is a leak.
  it("forgets a finished task once its time is up", () => {
    let clock = 1_000;
    const reg = createTaskRegistry({ ttlMs: 500, now: () => clock });
    reg.create("a");
    reg.succeed("a", {});

    clock = 1_400;
    reg.prune();
    expect(reg.get("a")).toBeDefined();

    clock = 1_600;
    reg.prune();
    expect(reg.get("a")).toBeUndefined();
  });

  it("never forgets a task that has not finished", () => {
    let clock = 1_000;
    const reg = createTaskRegistry({ ttlMs: 500, now: () => clock });
    reg.create("a");
    reg.setStarted("a");

    clock = 99_000;
    reg.prune();
    expect(reg.get("a")?.status).toBe("started");
  });
});

describe("toTaskStatusResponse", () => {
  it("answers in docling-serve's TaskStatusResponse shape", () => {
    const reg = createTaskRegistry();
    reg.create("a");

    expect(toTaskStatusResponse(reg.get("a")!, 0)).toEqual({
      task_id: "a",
      task_status: "pending",
      task_position: 0,
      task_meta: null,
    });
  });

  // The piece reads error_message off a failed poll; without it a failure is
  // indistinguishable from a blank one.
  it("carries the failure's message when there is one", () => {
    const reg = createTaskRegistry();
    reg.create("a");
    reg.fail("a", { status: 500, body: { error: "CONVERT_FAILED" } });

    const out = toTaskStatusResponse(reg.get("a")!, 0);
    expect(out.task_status).toBe("failure");
    expect(String(out.error_message)).toContain("CONVERT_FAILED");
  });

  it("reports no position for a task that is already running", () => {
    const reg = createTaskRegistry();
    reg.create("a");
    reg.setStarted("a");
    expect(toTaskStatusResponse(reg.get("a")!, 0).task_position).toBe(0);
  });
});
