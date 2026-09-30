// @ts-check
/**
 * The registry behind the v1 async job routes.
 *
 * docling-serve's async shape is submit -> poll -> read: `POST
 * /v1/convert/source/async` hands back a task id, `/v1/status/poll/{id}` says
 * how it is going, `/v1/result/{id}` gives the answer. This service converts
 * one document at a time, so submitting is joining a queue — which is a
 * better answer than the `503 CONVERSION_BUSY` a synchronous caller gets,
 * since the work is accepted rather than refused.
 *
 * Kept apart from the server so the state machine can be tested without a
 * socket or a conversion.
 */

/**
 * @typedef {"pending" | "started" | "success" | "failure"} TaskStatus
 * @typedef {{ status: number, body: unknown }} TaskError
 * @typedef {{ id: string, status: TaskStatus, result?: unknown, error?: TaskError, createdAt: number, finishedAt?: number }} Task
 */

/**
 * @param {{ ttlMs?: number, now?: () => number }} [opts]
 */
export function createTaskRegistry(opts = {}) {
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  /** @type {Map<string, Task>} */
  const tasks = new Map();

  /** @param {string} id */
  const finish = (id) => {
    const task = tasks.get(id);
    if (task) task.finishedAt = now();
    return task;
  };

  return {
    /** @param {string} id */
    create(id) {
      /** @type {Task} */
      const task = { id, status: "pending", createdAt: now() };
      tasks.set(id, task);
      return task;
    },
    /** @param {string} id */
    get(id) {
      return tasks.get(id);
    },
    /** @param {string} id */
    setStarted(id) {
      const task = tasks.get(id);
      if (task) task.status = "started";
      return task;
    },
    /** @param {string} id @param {unknown} result */
    succeed(id, result) {
      const task = tasks.get(id);
      if (task) {
        task.status = "success";
        task.result = result;
      }
      return finish(id);
    },
    /** @param {string} id @param {TaskError} error */
    fail(id, error) {
      const task = tasks.get(id);
      if (task) {
        task.status = "failure";
        task.error = error;
      }
      return finish(id);
    },
    /**
     * How many still-queued tasks are ahead of this one. A task that is
     * running or finished is not in the queue, so its position is 0.
     * @param {string} id
     */
    positionOf(id) {
      let ahead = 0;
      for (const task of tasks.values()) {
        if (task.id === id) break;
        if (task.status === "pending") ahead += 1;
      }
      return tasks.get(id)?.status === "pending" ? ahead : 0;
    },
    /** Drop finished tasks whose time is up; unfinished ones are never dropped. */
    prune() {
      const cutoff = now() - ttlMs;
      for (const [id, task] of tasks) {
        if (task.finishedAt !== undefined && task.finishedAt <= cutoff) {
          tasks.delete(id);
        }
      }
    },
  };
}

/**
 * @param {Task} task
 * @param {number} position
 */
export function toTaskStatusResponse(task, position) {
  /** @type {Record<string, unknown>} */
  const out = {
    task_id: task.id,
    task_status: task.status,
    task_position: position,
    task_meta: null,
  };
  if (task.status === "failure") {
    const body = task.error?.body;
    const message =
      body !== null && typeof body === "object" && "error" in body
        ? String(/** @type {{ error: unknown }} */ (body).error)
        : `conversion failed with status ${task.error?.status ?? "unknown"}`;
    out.error_message = message;
  }
  return out;
}
