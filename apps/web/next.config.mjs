/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  transpilePackages: ['@planiq/shared'],
  images: { remotePatterns: [{ protocol: 'http', hostname: '**' }, { protocol: 'https', hostname: '**' }] },
};
export default nextConfig;
