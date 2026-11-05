/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
