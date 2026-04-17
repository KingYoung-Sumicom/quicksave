/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  future: {
    // Scope `hover:` to pointer devices so mobile taps don't leave sticky hover states.
    hoverOnlyWhenSupported: true,
  },
  theme: {
    extend: {
      colors: {
        // Git status colors
        added: '#22c55e',
        modified: '#eab308',
        deleted: '#ef4444',
        renamed: '#8b5cf6',
      },
    },
  },
  plugins: [],
};
