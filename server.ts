import index from "./index.html";

// "/" -> bundled game (index.html + main.js); everything else = static files from this folder (the KayKit models/textures)
Bun.serve({
  port: 3000,
  development: true,
  routes: { "/": index },
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path.includes("..") || path.startsWith("/node_modules")) return new Response("nope", { status: 403 });
    const f = Bun.file("." + path);
    return (await f.exists()) ? new Response(f) : new Response("404", { status: 404 });
  },
});
console.log("http://localhost:3000");
