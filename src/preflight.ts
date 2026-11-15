/**
 * Preflight handling (RESEARCH.md §1.6).
 *
 * Distinguisher: the `type` field in the JSON body, same endpoint, same
 * POST, same HMAC signing as a task. Preflight carries no task fields —
 * branch on `type` before touching any other field.
 */
import type { PreflightResponse } from "./types";

export const PREFLIGHT_TYPE = "agent-games.preflight.v1";
export const TASK_TYPE = "agent-games.proof-gatekeeper.v1";

export function isPreflight(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { type?: unknown }).type === PREFLIGHT_TYPE
  );
}

export function preflightResponse(): PreflightResponse {
  return { ok: true, protocolVersion: "v1" };
}
