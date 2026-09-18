/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./App.tsx', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      // Shared design tokens — keep in sync with admin-web/src/index.css (@theme)
      // Quality Monitoring design system (worker + staff screens). Calm neutrals, one brand accent
      // (maroon from the app logo) and muted status colours that only ever mean a status.
      colors: {
        canvas: '#F5F5F7',
        surface: '#FFFFFF',
        subtle: '#F0F0F3',
        line: { DEFAULT: '#E3E3E8', strong: '#D1D1D6' },
        ink: { DEFAULT: '#1D1D1F', secondary: '#48484A', muted: '#6E6E73', faint: '#8E8E93' },
        accent: { DEFAULT: '#7F3D40', press: '#6A3235', soft: '#F4ECEC' },
        success: { DEFAULT: '#1E7B34', bg: '#EDF7EF', line: '#CBE7D2' },
        due: { DEFAULT: '#0B64B8', bg: '#EDF4FB', line: '#C6DDF3' },
        missed: { DEFAULT: '#C1271D', bg: '#FCEFEE', line: '#F3CBC7' },
        exception: { DEFAULT: '#A85200', bg: '#FDF3E8', line: '#F2D7B8' },
        failed: { DEFAULT: '#C1271D', bg: '#FCEFEE', line: '#F3CBC7' },
        // Staff (Admin/Manager) screens use the same palette under their own names.
        staff: {
          bg: '#F5F5F7',
          card: '#FFFFFF',
          fill: '#F0F0F3',
          press: '#E5E5EA',
          line: '#E5E5EA',
          field: '#D1D1D6',
          ink: '#1D1D1F',
          ink2: '#48484A',
          muted: '#6E6E73',
          faint: '#8E8E93',
          primary: '#7F3D40',
          accent: '#7F3D40',
          'accent-soft': '#F4ECEC'
        }
      }
    }
  },
  plugins: []
}
