/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages are shipped as TS source — let Next compile them.
  transpilePackages: ['@inflexion/sdk', '@inflexion/engine'],
  // Lint is run separately (root prettier + future eslint); don't fail builds on it.
  eslint: { ignoreDuringBuilds: true },
  webpack: (config) => {
    // Wallet SDKs (MetaMask / WalletConnect / Coinbase via RainbowKit + wagmi) and
    // ox/viem reference optional deps that don't exist in a browser bundle — React
    // Native storage, the pino-pretty logger, node-fetch's `encoding`, WalletConnect's
    // `lokijs`. Resolve them to empty modules so the build doesn't fail to find them.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      '@react-native-async-storage/async-storage': false,
      'pino-pretty': false,
      encoding: false,
      lokijs: false,
    }
    // ox uses a computed require() that webpack flags as a "critical dependency"; it's
    // benign in this browser build, so silence just that warning.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      /Critical dependency: the request of a dependency is an expression/,
    ]
    return config
  },
}

export default nextConfig
