import type { UploadFile } from "./upload-queue";
import { readApiResponse } from "./api-response";

// Client-only feedback; these outcomes never change API or database contracts.
export type OperationState = {
  outcome: "pending" | "success" | "failure";
  text: string;
  pendingDisplay?: "fullscreen" | "inline";
  detail?: string;
  completed?: number;
  total?: number;
  files?: Pick<UploadFile, "id" | "name" | "state" | "progress">[];
};

export class RequestTimeoutError extends Error {
  constructor(public readonly write: boolean) {
    super(write
      ? "The request timed out. Its result is uncertain. Refresh status before retrying; do not submit again yet."
      : "The request timed out. Please retry.");
    this.name = "RequestTimeoutError";
  }
}

export async function boundedRequest<T>(task: (signal: AbortSignal) => Promise<T>, write = false, timeout = 120_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      task(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new RequestTimeoutError(write));
          controller.abort();
        }, timeout);
      }),
    ]);
  } finally { clearTimeout(timer!); }
}

export function requestJson(url: string, init: RequestInit = {}, write = init.method === "POST") {
  return boundedRequest(async signal => readApiResponse(await fetch(url, { ...init, signal })), write);
}
