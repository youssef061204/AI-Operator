/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  transpilePackages: ["@operator-assist/shared"],
};

export default nextConfig;
