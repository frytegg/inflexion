import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Routes that live on the app surface (app.inflexion.xyz). Everything else under
// `/` is the marketing surface (inflexion.xyz). One Next app, two domains.
const APP_ROUTES = ['/protect', '/earn', '/underwrite', '/dashboard', '/markets', '/data']

/**
 * Domain split. PRODUCTION-ONLY: on the real hosts, marketing redirects app
 * routes to the app subdomain, and the app root redirects to /markets. Localhost
 * and Vercel previews pass through unchanged so the full app is reachable in dev.
 */
export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') ?? '').toLowerCase()
  const { pathname } = req.nextUrl

  const isAppHost = host.startsWith('app.')
  const isMarketingHost = host === 'inflexion.xyz' || host === 'www.inflexion.xyz'

  if (isMarketingHost && APP_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`))) {
    return NextResponse.redirect(
      new URL(`https://app.inflexion.xyz${pathname}${req.nextUrl.search}`),
    )
  }
  if (isAppHost && pathname === '/') {
    return NextResponse.redirect(new URL('/markets', req.url))
  }
  return NextResponse.next()
}

export const config = {
  // Skip static assets, _next internals, and api routes.
  matcher: ['/((?!_next/|.*\\..*|api/).*)'],
}
