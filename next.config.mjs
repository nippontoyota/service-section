/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  async headers() {
    return ["/security/:path*", "/g/:path*", "/api/gate-passes/:path*"].map(source => ({ source, headers: [
      { key: "Cache-Control", value: "private, no-store, max-age=0" },
      { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
      { key: "Referrer-Policy", value: "no-referrer" },
    ] }));
  },
  outputFileTracingRoot: process.cwd(),
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  serverExternalPackages: ["pdf-parse"],
  outputFileTracingIncludes: {
    "/api/**": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/pdf-parse/dist/pdf-parse/{cjs,esm}/pdf.worker.mjs",
      "./node_modules/@napi-rs/canvas*/**/*",
    ],
  },
};

export default nextConfig;
