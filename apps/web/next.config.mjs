/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages are shipped as TS source — let Next compile them.
  transpilePackages: ['@inflexion/sdk', '@inflexion/engine'],
  // Lint is run separately (root prettier + future eslint); don't fail builds on it.
  eslint: { ignoreDuringBuilds: true },
}

export default nextConfig
