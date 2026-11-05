export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  // Next may use the internal bind address in request.url. Host identifies the
  // browser-facing destination and cannot be overridden by cross-origin JS.
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (origin) {
    const source = new URL(origin);
    if (!["http:", "https:"].includes(source.protocol) || source.host !== host) {
      throw new Error("Same-origin JSON request required");
    }
  }
  if (request.headers.get("sec-fetch-site") === "cross-site"
    || request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") {
    throw new Error("Same-origin JSON request required");
  }
}
