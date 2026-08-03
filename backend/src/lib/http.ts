/**
 * Plain JSON Response with a status forwarded from an upstream fetch() call
 * (a runtime `number`, not one of Hono's literal-typed status codes) — bypasses
 * `c.json()`'s `ContentfulStatusCode` union, which only accepts status literals
 * known at compile time.
 */
export function jsonResponse(data: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8', ...headers },
  });
}
