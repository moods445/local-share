const dev = process.env.NODE_ENV === 'development';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 开发与生产使用不同构建目录，避免 npm run dev 覆盖 .next 导致 npm start 失效
  distDir: dev ? '.next-dev' : '.next',
  images: { unoptimized: true },
  trailingSlash: true,
  reactStrictMode: true,
};

export default nextConfig;
