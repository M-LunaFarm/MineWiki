/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: '/verify/:sessionId',
        destination: '/me?verifySessionId=:sessionId',
        permanent: false
      },
      {
        source: '/guilds',
        destination: '/dashboard',
        permanent: false
      },
      {
        source: '/guilds/:path*',
        destination: '/dashboard',
        permanent: false
      },
      {
        source: '/auth/microsoft',
        destination: '/me',
        permanent: false
      }
    ];
  },
  typescript: {
    ignoreBuildErrors: true
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
