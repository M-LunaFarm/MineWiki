import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Modern dark theme colors
        background: '#070b0f',
        foreground: '#f4f8fb',
        card: {
          DEFAULT: '#0d141c',
          foreground: '#f4f8fb',
        },
        popover: {
          DEFAULT: '#0d141c',
          foreground: '#f4f8fb',
        },
        primary: {
          50: '#ecfff8',
          100: '#d2fff0',
          200: '#a7fbe0',
          300: '#6df0ca',
          400: '#2fddab',
          500: '#14c794',
          600: '#0fa277',
          700: '#0f7f60',
          800: '#10654d',
          900: '#104f3e',
          DEFAULT: '#14c794',
          foreground: '#05140f',
        },
        secondary: {
          DEFAULT: '#15212d',
          foreground: '#e6eff7',
        },
        muted: {
          DEFAULT: '#111b25',
          foreground: '#8ea1b4',
        },
        accent: {
          DEFAULT: '#1ac5d9',
          foreground: '#031217',
        },
        destructive: {
          DEFAULT: '#ef4444',
          foreground: '#fafafa',
        },
        border: 'rgba(193, 223, 248, 0.18)',
        input: 'rgba(193, 223, 248, 0.18)',
        ring: '#1ac5d9',

        // Brand colors
        brand: {
          50: '#ecfff8',
          100: '#d2fff0',
          200: '#a7fbe0',
          300: '#6df0ca',
          400: '#2fddab',
          500: '#14c794',
          600: '#0fa277',
          700: '#0f7f60',
          800: '#10654d',
          900: '#104f3e',
        },

        // Surface colors for cards and panels
        surface: {
          50: '#fafafa',
          100: '#0d141c',
          200: '#15212d',
          300: '#1f2f3f',
          400: '#2d4256',
          500: '#44617b',
          600: '#6483a0',
          700: '#9ab3c8',
          800: '#c6d7e6',
          900: '#eaf2f8',
        },
      },
      borderRadius: {
        lg: '0.75rem',
        md: '0.5rem',
        sm: '0.25rem',
      },
      fontFamily: {
        sans: [
          'var(--font-body)',
          'Pretendard',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        display: [
          'var(--font-display)',
          'var(--font-body)',
          'Pretendard',
          'Segoe UI',
          'sans-serif',
        ],
        mono: [
          'var(--font-mono)',
          'JetBrains Mono',
          'SF Mono',
          'Monaco',
          'Inconsolata',
          'Fira Code',
          'monospace',
        ],
      },
      fontSize: {
        '2xs': '0.625rem',
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'fade-in': 'fade-in 0.5s ease-out',
        'fade-up': 'fade-up 0.5s ease-out',
        'slide-in': 'slide-in 0.3s ease-out',
        'scale-in': 'scale-in 0.2s ease-out',
        'spin-slow': 'spin 3s linear infinite',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-up': {
          from: {
            opacity: '0',
            transform: 'translateY(10px)',
          },
          to: {
            opacity: '1',
            transform: 'translateY(0)',
          },
        },
        'slide-in': {
          from: {
            transform: 'translateX(-100%)',
          },
          to: {
            transform: 'translateX(0)',
          },
        },
        'scale-in': {
          from: {
            transform: 'scale(0.95)',
            opacity: '0',
          },
          to: {
            transform: 'scale(1)',
            opacity: '1',
          },
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-conic': 'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
        'gradient-brand': 'linear-gradient(135deg, #13c794 0%, #17c8e5 100%)',
        'gradient-dark': 'linear-gradient(135deg, #0d141c 0%, #15212d 100%)',
      },
    },
  },
  plugins: [],
};

export default config;
