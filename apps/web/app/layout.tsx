import type { Metadata } from 'next'
import { Space_Grotesk, IBM_Plex_Mono } from 'next/font/google'
import './globals.css'
import '../components/menu/staggered-menu.css'
import { Providers } from './providers'

// Display (Space Grotesk) + Mono (IBM Plex Mono) self-hosted via next/font.
// Body (General Sans) loads from the Fontshare CDN (<link> below).
const display = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '700'],
  variable: '--font-display',
  display: 'swap',
})
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Inflexion — hedge Uniswap v3 impermanent loss',
  description:
    'Pay a fixed premium, transfer the in-range impermanent-loss risk of your Uniswap v3 position. Paid your realized IL at expiry — capped at MaxIL.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <link
          rel="stylesheet"
          href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&display=swap"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
