# KayKit Trials

3D platformer prototype: Three.js + Rapier physics, built with Bun. Two courses: a floating **Sky Course** and a ground-level **Land of Traps**.

```
bun install
bun run dev      # http://localhost:3000
bun run build    # static site in dist/ (what GitHub Pages serves)
```

Controls: WASD move, mouse look, Space jump (x2), F fly-cam, R respawn, 1-9 jump to a zone, Esc menu. On a mobile OS an on-screen joystick, jump and menu button appear (`?touch=1` forces them on for desktop testing).

Pushing to `main` deploys via `.github/workflows/pages.yml` (set Settings -> Pages -> Source to "GitHub Actions").

Assets: [KayKit Adventurers](https://kaylousberg.itch.io/kaykit-adventurers), [KayKit Platformer](https://kaylousberg.itch.io/kaykit-platformer) and UI pack, all CC0 by Kay Lousberg.
