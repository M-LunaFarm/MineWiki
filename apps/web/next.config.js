/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const apiBaseUrl = (process.env.INTERNAL_API_BASE_URL ?? 'http://127.0.0.1:3000')
      .replace(/\/+$/, '');
    return [
      {
        source: '/api/:path*',
        destination: `${apiBaseUrl}/:path*`
      }
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'mc-heads.net',
        pathname: '/avatar/**'
      },
      {
        protocol: 'https',
        hostname: 'crafatar.com',
        pathname: '/avatars/**'
      }
    ]
  }
};

export default nextConfig;
