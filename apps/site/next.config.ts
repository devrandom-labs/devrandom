import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    cpus: 1,
  },
  output: 'export',
  trailingSlash: true,
};

export default nextConfig;
