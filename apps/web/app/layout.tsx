import type { Metadata } from 'next'
import { IBM_Plex_Mono } from 'next/font/google'
import './globals.css'
import '../components/menu/staggered-menu.css'
import { Providers } from './providers'

// Mono (IBM Plex Mono) self-hosted via next/font. Display (Clash Display) + body
// (General Sans) load from the Fontshare CDN (<link> below); their families are named
// in globals.css :root as --font-display / --font-sans.
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
    <html lang="en" className={mono.variable} suppressHydrationWarning>
      <head>
        <link
          rel="stylesheet"
          href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&f[]=clash-display@400,500,600,700&display=swap"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
