export type TaskStatus = "pending" | "started" | "success" | "failure";
export type TaskError = { status: number; body: unknown };
export type Task = {
  id: string;
  status: TaskStatus;
  result?: unknown;
  error?: TaskError;
  createdAt: number;
  finishedAt?: number;
};

export type TaskRegistry = {
  create(id: string): Task;
  get(id: string): Task | undefined;
  setStarted(id: string): Task | undefined;
  succeed(id: string, result: unknown): Task | undefined;
  fail(id: string, error: TaskError): Task | undefined;
  /** How many still-queued tasks are ahead of this one. */
  positionOf(id: string): number;
  /** Drop finished tasks past their time to live. */
  prune(): void;
};

export function createTaskRegistry(opts?: {
  ttlMs?: number;
  now?: () => number;
}): TaskRegistry;

export function toTaskStatusResponse(
  task: Task,
  position: number,
): Record<string, unknown>;
