import './ui.js';
// game.js uses top-level await, so it is loaded dynamically (Bun's dev bundler can't take TLA in the entry module). No ?map= -> only the menu shows.
if (new URLSearchParams(location.search).get('map')) import('./game.js');
