module.exports = {
  content: ['src/web/views/**/*.ejs', 'src/web/**/*.js'],
  theme: {
    extend: {}
  },
  plugins: [require('@tailwindcss/forms'), require('@tailwindcss/container-queries')]
};
