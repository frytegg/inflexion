import type { Config } from 'tailwindcss'

// Materialized from apps/web/DESIGN_TOKENS.md (locked 2026-06-05). Edit the doc
// first, then mirror here — the doc is the source of truth.
const config: Config = {
  darkMode: 'class', // dark is the default + only theme at launch
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // surfaces
        canvas: '#0B1220',
        base: '#0E1525',
        raised: '#131C30',
        overlay: '#18233A',
        inset: '#080E1A',
        // borders / lines
        line: { subtle: '#1B2740', DEFAULT: '#233142', strong: '#2F4156' },
        // foreground
        fg: { DEFAULT: '#F3F5F7', secondary: '#AEB9CA', tertiary: '#707E96', disabled: '#4A5670' },
        // accent (teal) — brand
        accent: {
          300: '#5EEAD4',
          400: '#2DD4BF',
          DEFAULT: '#14B8A6',
          500: '#14B8A6',
          600: '#0E9C8C',
          700: '#0B7D70',
          fg: '#06231F',
        },
        // semantic
        loss: {
          300: '#FCA5A5',
          400: '#F87171',
          DEFAULT: '#EF5350',
          500: '#EF5350',
          600: '#DC4040',
        },
        warn: { 400: '#FBBF24', DEFAULT: '#F59E0B', 500: '#F59E0B' },
        mm: { 400: '#7C9CF5', DEFAULT: '#5B7FE0', 500: '#5B7FE0' },
        // data-viz
        viz: {
          curve: '#F3F5F7',
          value: '#2DD4BF',
          cap: '#FBBF24',
          pool: '#2DD4BF',
          mm: '#8B7FF0',
          grid: '#1B2740',
          axis: '#707E96',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        'display-2xl': ['4.5rem', { lineHeight: '1.05', letterSpacing: '-0.02em' }],
        'display-xl': ['3.5rem', { lineHeight: '1.08', letterSpacing: '-0.02em' }],
        'display-lg': ['2.75rem', { lineHeight: '1.1', letterSpacing: '-0.015em' }],
        h1: ['2.125rem', { lineHeight: '1.15', letterSpacing: '-0.01em' }],
        h2: ['1.625rem', { lineHeight: '1.2', letterSpacing: '-0.01em' }],
        h3: ['1.25rem', { lineHeight: '1.3' }],
        h4: ['1.0625rem', { lineHeight: '1.4' }],
        'body-lg': ['1.0625rem', { lineHeight: '1.6' }],
        body: ['0.9375rem', { lineHeight: '1.6' }],
        'body-sm': ['0.8125rem', { lineHeight: '1.5' }],
        label: ['0.75rem', { lineHeight: '1.4', letterSpacing: '0.06em' }],
        'mono-stat': ['1.75rem', { lineHeight: '1.1', letterSpacing: '-0.01em' }],
        mono: ['0.9375rem', { lineHeight: '1.5' }],
        'mono-sm': ['0.8125rem', { lineHeight: '1.4' }],
        'mono-xs': ['0.6875rem', { lineHeight: '1.4', letterSpacing: '0.02em' }],
      },
      borderRadius: { xs: '2px', sm: '4px', md: '6px', lg: '8px', xl: '12px', '2xl': '16px' },
      boxShadow: {
        sm: '0 1px 2px rgba(0,0,0,.30)',
        md: '0 4px 12px rgba(0,0,0,.35)',
        lg: '0 12px 32px rgba(0,0,0,.45)',
        glow: '0 0 0 1px rgba(20,184,166,.5), 0 0 24px rgba(20,184,166,.15)',
      },
      transitionTimingFunction: {
        entrance: 'cubic-bezier(.16,1,.3,1)',
        standard: 'cubic-bezier(.4,0,.2,1)',
      },
      transitionDuration: { instant: '100ms', fast: '160ms', base: '220ms', slow: '320ms' },
    },
  },
  plugins: [],
}

export default config
