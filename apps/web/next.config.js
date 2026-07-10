/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
