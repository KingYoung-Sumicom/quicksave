/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
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
