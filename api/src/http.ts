import type { ApiErrorCode } from "@partally/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import type { UserRecord } from "./repository.js";

export type Env = { Variables: { user: UserRecord } };

export function fail(c: Context, status: ContentfulStatusCode, error: ApiErrorCode, message?: string) {
  return c.json({ error, message }, status);
}

export async function parseBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: Response }> {
  const json = await c.req.json().catch(() => undefined);
  const result = schema.safeParse(json);
  if (!result.success) {
    return { ok: false, response: fail(c, 400, "bad_request", result.error.issues[0]?.message) };
  }
  return { ok: true, data: result.data };
}
