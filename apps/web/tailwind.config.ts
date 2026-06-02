import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#E11D2A', 600: '#C41722', 50: '#FEF2F2' },
        ink: '#0f172a',
      },
    },
  },
  plugins: [],
} satisfies Config;
