/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./App.tsx', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      // Shared design tokens — keep in sync with admin-web/src/index.css (@theme)
      colors: {
        canvas: '#F8F9FA',
        surface: '#FFFFFF',
        subtle: '#F1F5F9',
        line: { DEFAULT: '#E2E8F0', strong: '#CBD5E1' },
        ink: { DEFAULT: '#0F172A', secondary: '#475569', muted: '#64748B', faint: '#94A3B8' },
        accent: '#1E40AF',
        success: { DEFAULT: '#15803D', bg: '#F0FDF4', line: '#BBF7D0' },
        due: { DEFAULT: '#0369A1', bg: '#F0F9FF', line: '#BAE6FD' },
        missed: { DEFAULT: '#B91C1C', bg: '#FEF2F2', line: '#FECACA' },
        exception: { DEFAULT: '#B45309', bg: '#FFFBEB', line: '#FDE68A' },
        failed: { DEFAULT: '#DC2626', bg: '#FEF2F2', line: '#FCA5A5' }
      }
    }
  },
  plugins: []
}
