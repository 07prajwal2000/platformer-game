// Map 2: "Land of Traps" — everything sits on the ground. A straight course along -Z split into zones by gate walls.
// Receives the engine through `c` (see ctx in game.js) so it has no circular imports.
import * as THREE from 'three';

export async function buildLand(c) {
  const { RAPIER, scene, L, get, prop, plat, box, mover, shoot, flash, cannon, pickup, spring, rnd, hurt, pPos, CENTER } = c;
  const tick = (f) => L.ticks.push(f);
  const HALF_W = 62; // ground slabs are wider than any corridor; walls do the real bounding

  // ---------------------------------------------------------------- zones
  const Z = {
    start: { z0: 24, z1: -12, hw: 22, ground: 0x78d46e, wall: 0xe8d9b0, arch: 'green' },
    spikes: { z0: -12, z1: -50, hw: 12, ground: 0x9bd95f, wall: 0x9ec27a, arch: 'yellow' },
    lava: { z0: -50, z1: -92, hw: 20, ground: 0x7a6558, wall: 0x8a4b3a, arch: 'red' },
    cannons: { z0: -92, z1: -128, hw: 11, ground: 0xa7afb8, wall: 0x7b8794, arch: 'blue' },
    spinner: { z0: -128, z1: -172, hw: 22, ground: 0xe6cd8f, wall: 0xc9a45d, arch: 'yellow' },
    boulder: { z0: -172, z1: -214, hw: 12, ground: 0xb58d5e, wall: 0x8c6a45, arch: 'red' },
    crusher: { z0: -214, z1: -240, hw: 9, ground: 0x7d8899, wall: 0x56606f, arch: 'blue' },
    belts: { z0: -240, z1: -278, hw: 17, ground: 0x6d8bab, wall: 0x4d6a8a, arch: 'green' },
    mortar: { z0: -278, z1: -322, hw: 24, ground: 0x93705f, wall: 0x6b4b3f, arch: 'red' },
    finish: { z0: -322, z1: -352, hw: 16, ground: 0x78d46e, wall: 0xe8d9b0, arch: 'green' },
  };
  const WALL_H = 9, GATE = 7;
  L.spawn = { x: 0, y: 0.2, z: 18 };
  L.tp = ['start', 'spikes', 'lava', 'cannons', 'spinner', 'boulder', 'crusher', 'belts', 'mortar'].map((k) => [0, 0, k === 'start' ? 18 : Z[k].z0 - (k === 'spikes' ? 2.5 : 7)]); // spawn a bit inside each zone

  // ---------------------------------------------------------------- terrain helpers
  const lavas = [];
  // ground slab(s) for a zone, with rectangular lava holes cut out. z0 > z1.
  function ground(z, holes = []) {
    const zs = [...new Set([z.z0 + 0.05, z.z1 - 0.05, ...holes.flatMap((h) => [h.z0, h.z1])])].sort((a, b) => b - a);
    const slab = (xa, xb, za, zb) => box((xa + xb) / 2, -3, (za + zb) / 2, xb - xa, 6, za - zb, { color: z.ground, tile: 6, shadow: false });
    for (let i = 0; i < zs.length - 1; i++) {
      const a = zs[i], b = zs[i + 1], mid = (a + b) / 2;
      let x = -HALF_W;
      for (const h of [...holes.filter((h) => mid < h.z0 && mid > h.z1).sort((p, q) => p.x0 - q.x0), { x0: HALF_W, x1: HALF_W }]) {
        if (h.x0 > x) slab(x, h.x0, a, b);
        x = h.x1;
      }
    }
    for (const h of holes) {
      const w = h.x1 - h.x0, d = h.z0 - h.z1, cx = (h.x0 + h.x1) / 2, cz = (h.z0 + h.z1) / 2;
      box(cx, -5, cz, w, 2, d, { color: 0x3a2a24, shadow: false }); // pit floor (catches falling tiles/balls)
      const lava = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: 0xff5a1f }));
      lava.rotation.x = -Math.PI / 2;
      lava.position.set(cx, -1.4, cz);
      scene.add(lava);
      lavas.push(lava);
      const n = { x0: h.x0, x1: h.x1, z0: h.z1, z1: h.z0 }; // normalized (z0 < z1) for the engine's rect tests
      L.holes.push({ ...n, y: -0.6 });
      L.avoid.push(n);
    }
  }
  tick((dt, t) => lavas.forEach((m, i) => m.material.color.setHSL(0.03 + 0.012 * Math.sin(t * 2.5 + i), 1, 0.52 + 0.06 * Math.sin(t * 4 + i * 2))));

  const wall = (x, z0, z1, w, color) => box(x, WALL_H / 2, (z0 + z1) / 2, w, WALL_H, Math.abs(z0 - z1), { color, shadow: false });
  async function archFit(x, y, z, color, width) {
    const o = await get('arch_wide', color);
    const sz = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
    o.scale.setScalar(width / sz.x);
    o.position.set(x, y, z);
    scene.add(o);
  }
  // side walls of a zone + the gate wall at its far end (opening GATE wide at x=0, spanning the wider neighbour)
  async function walls(z, next) {
    wall(-(z.hw + 1), z.z0, z.z1, 2, z.wall);
    wall(z.hw + 1, z.z0, z.z1, 2, z.wall);
    const hw = Math.max(z.hw, next?.hw ?? z.hw) + 2;
    wall(-(GATE / 2 + hw) / 2, z.z1 + 1, z.z1 - 1, hw - GATE / 2, z.wall);
    box((GATE / 2 + hw) / 2, WALL_H / 2, z.z1, hw - GATE / 2, WALL_H, 2, { color: z.wall, shadow: false });
    await archFit(0, 0, z.z1, z.arch, GATE - 0.6);
  }
  // a ramp: top surface runs from (ya at za) to (yb at zb)
  function ramp(x, ya, za, yb, zb, w, color) {
    const rx = Math.atan((yb - ya) / (za - zb)), len = Math.hypot(za - zb, yb - ya), th = 2;
    box(x, (ya + yb) / 2 - (Math.cos(rx) * th) / 2, (za + zb) / 2 - (Math.sin(rx) * th) / 2, w, th, len, { color, rx });
  }
  const stripeTex = (() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    g.fillStyle = '#ffd23f';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#2b2b2b';
    for (let i = -64; i < 128; i += 32) (g.beginPath(), g.moveTo(i, 64), g.lineTo(i + 16, 64), g.lineTo(i + 80, 0), g.lineTo(i + 64, 0), g.fill());
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const stars = (list) => Promise.all(list.map(([x, y, z]) => pickup('star', 'yellow', x, y, z)));

  // horizon (outside the walls)
  const far = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshBasicMaterial({ color: 0x62b85a }));
  far.rotation.x = -Math.PI / 2;
  far.position.y = -6.1; // below the pits so lava stays visible
  scene.add(far);

  const zones = Object.values(Z);
  const zh = { cannons: [], spikes: [] };

  // ================================================================ 1. START MEADOW: stairs, ramps, KayKit blocks
  ground(Z.start);
  for (let i = 0; i < 8; i++) { // stairs (0.3 steps are walkable via autostep)
    const h = 0.3 * (i + 1);
    box(-13, h / 2, 14 - i - 0.5, 6, h, 1, { color: 0xf2c46d });
  }
  box(-13, 1.2, 3, 6, 2.4, 6, { color: 0xf2c46d, tile: 6 }); // plateau
  ramp(-13, 2.4, 0, 0, -10, 6, 0xf28c6d); // slide down
  await prop('platform_slope_4x4x4', 'yellow', 13, 0, 4, { hull: true });
  await plat('platform_4x4x4', 'green', 13, 4, 0);
  await plat('platform_4x4x2', 'blue', 13, 2, -4);
  await plat('platform_4x4x1', 'yellow', 13, 1, -8);
  for (const x of [-4, 4]) await prop('cone', 'red', x, 0, 14);
  await prop('signage_arrow_stand', 'red', 0, 0, 12);
  await stars([[-13, 3.5, 3], [13, 5.5, 0], [0, 1.3, 4], [-13, 1.3, -6], [13, 3.5, -4]]);
  await walls(Z.start, Z.spikes);

  // ================================================================ 2. SPIKE GARDEN: timed floor spikes
  ground(Z.spikes);
  {
    const cone = await get('cone', 'red');
    let cg, cm;
    cone.traverse((m) => m.isMesh && ((cg = m.geometry), (cm = m.material)));
    const plates = [];
    const cols = [-10, -6, -2, 2, 6, 10], rows = [-17, -21, -25, -29, -33, -37, -41, -45];
    rows.forEach((pz, r) =>
      cols.forEach((px, cI) => {
        const safe = (cI + r) % 4 === 0; // diagonal stripes of permanent safe tiles
        box(px, 0.06, pz, 3.8, 0.12, 3.8, { color: safe ? 0x7ddc8a : 0x434d5e, solid: false, shadow: false });
        if (!safe) plates.push({ x: px, z: pz, ph: ((r * 0.9 + cI * 0.37) % 3.4) / 3.4, h: 0 });
      }),
    );
    L.avoid.push({ x0: -12, x1: 12, z0: -47, z1: -15 });
    const inst = new THREE.InstancedMesh(cg, cm, plates.length * 9);
    inst.castShadow = true;
    inst.frustumCulled = false;
    scene.add(inst);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3(1.4, 1.6, 1.4);
    tick((dt, t) => {
      let n = 0;
      for (const p of plates) {
        const u = (t / 3.4 + p.ph) % 1;
        p.h = u < 0.45 ? 0 : u < 0.62 ? 0.22 + 0.1 * Math.sin(t * 70) : u < 0.85 ? 1 : 1 - (u - 0.85) / 0.15; // hidden / shiver (warning) / up / retract
        for (let k = 0; k < 9; k++)
          (pos.set(p.x + ((k % 3) - 1) * 1.1, -1.1 + 1.15 * p.h, p.z + (((k / 3) | 0) - 1) * 1.1), m4.compose(pos, q, sc), inst.setMatrixAt(n++, m4));
      }
      inst.instanceMatrix.needsUpdate = true;
    });
    L.hazards.push((p) => {
      for (const s of plates)
        if (s.h > 0.6 && Math.abs(p.x - s.x) < 2.1 && Math.abs(p.z - s.z) < 2.1 && p.y - CENTER < 0.9) {
          const d = Math.hypot(p.x - s.x, p.z - s.z) || 1;
          return hurt((p.x - s.x) / d, (p.z - s.z) / d, 4, 18, 10);
        }
    });
  }
  await stars([[-2, 1.3, -21], [2, 1.3, -29], [-2, 1.3, -37], [6, 1.3, -45]]);
  await walls(Z.spikes, Z.lava);

  // ================================================================ 3. LAVA RIVER: crumbling tiles / ferry platforms / spring hops
  const lavaHole = { x0: -20, x1: 20, z0: -60, z1: -82 };
  ground(Z.lava, [lavaHole]);
  // left lane: tiles that shake and drop once stepped on, then come back
  async function crumble(x, z) {
    const m = await prop('platform_2x2x1', 'yellow', x, -1, z, { kinematic: true });
    const cr = { touched: false, st: 0, t: 0 };
    L.crumbleByHandle.set(m.body.handle, cr);
    tick((dt) => {
      const touched = cr.touched;
      cr.touched = false;
      if (cr.st === 0 && touched) (cr.st = 1), (cr.t = 0.55);
      else if (cr.st === 1) {
        m.obj.position.x = x + Math.sin(cr.t * 70) * 0.07;
        if ((cr.t -= dt) <= 0) (cr.st = 2), (cr.t = 2.2), m.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      } else if (cr.st === 2) {
        const p = m.body.translation(), q = m.body.rotation();
        m.obj.position.set(p.x, p.y, p.z);
        m.obj.quaternion.set(q.x, q.y, q.z, q.w);
        if ((cr.t -= dt) <= 0) {
          m.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
          m.body.setTranslation({ x, y: -1, z }, true);
          m.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
          m.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          m.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          m.body.setEnabled(false);
          m.obj.visible = false;
          cr.st = 3;
          cr.t = 1.8;
        }
      } else if (cr.st === 3 && (cr.t -= dt) <= 0) {
        m.body.setEnabled(true);
        m.obj.position.set(x, -1, z);
        m.obj.quaternion.set(0, 0, 0, 1);
        m.obj.visible = true;
        cr.st = 0;
      }
    });
  }
  for (const z of [-62.5, -66, -69.5, -73, -76.5, -80]) await crumble(-14, z);
  // middle lane: two ferries sliding along z (opposite phases)
  for (const [x, ph] of [[-3, 0], [3, Math.PI]]) {
    const f = await prop('platform_4x2x1', 'red', x, -1, -71, { kinematic: true });
    mover(f.body, f.obj, (t) => ({ x, y: -1, z: -71 + 9.5 * Math.sin(t * 0.7 + ph) }));
  }
  // right lane: spring-hop over an island
  await spring(14, 0, -58.2, 19);
  await plat('platform_6x6x1', 'green', 14, 0, -71);
  await spring(14, 0, -73.2, 19);
  await stars([[-14, 1.4, -69.5], [0, 2.2, -71], [14, 1.6, -69], [-14, 1.4, -80]]);
  await walls(Z.lava, Z.cannons);

  // ================================================================ 4. CANNON CORRIDOR: crossfire + cover
  ground(Z.cannons);
  const zc = [-99, -105, -111, -117, -123];
  for (let i = 0; i < zc.length; i++) {
    const side = i % 2 ? 1 : -1;
    await cannon(side * 10.5, 1, zc[i], { target: () => new THREE.Vector3(-side * 9.5, 0.95, zc[i] + rnd(-1.5, 1.5)), T: 1, period: 2.7, delay: i * 0.55, bombs: 0.12, range: 45 });
  }
  await cannon(-9.5, 1, -126, { turret: true, T: 1.2, period: 3.4, bombs: 0.4, range: 45, target: () => new THREE.Vector3(pPos.x + c.pVel.x * 1.2, pPos.y, pPos.z + c.pVel.z * 1.2) });
  for (const [x, z] of [[-4, -102], [4, -108], [-4, -114], [4, -120]]) await prop('barrier_3x1x2', null, x, 0, z); // cover from the crossfire
  await stars([[-4, 1.3, -103.5], [4, 1.3, -109.5], [-4, 1.3, -115.5], [4, 1.3, -121.5]]);
  await walls(Z.cannons, Z.spinner);

  // ================================================================ 5. SPINNER PLAZA: sweeping bars
  ground(Z.spinner);
  {
    const spinners = [];
    // x, z, bar length, bar height, speed (rad/s)
    for (const [x, z, len, h, sp] of [[-8, -140, 12, 1, 1.2], [9, -150, 12, 1, -1.5], [-3, -162, 8, 4, 0.9], [14, -164, 8, 4, -1.1]]) {
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      const name = h > 1 ? 'barrier_4x1x4' : 'barrier_4x1x1';
      for (let k = 0; k < len / 4; k++) {
        const b = await get(name, h > 1 ? 'blue' : 'red');
        b.position.x = (k - (len / 4 - 1) / 2) * 4;
        g.add(b);
      }
      const hub = await get('pillar_1x1x4', null);
      g.add(hub);
      scene.add(g);
      spinners.push({ g, x, z, len, h, sp, ang: rnd(0, 6) });
    }
    tick((dt) => spinners.forEach((s) => ((s.ang += s.sp * dt), (s.g.rotation.y = s.ang))));
    L.hazards.push((p) => {
      for (const s of spinners) {
        const dx = p.x - s.x, dz = p.z - s.z, cs = Math.cos(s.ang), sn = Math.sin(s.ang);
        const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
        if (Math.abs(lx) < s.len / 2 + 0.3 && Math.abs(lz) < 0.8 && p.y - CENTER < s.h) {
          const sg = lz >= 0 ? 1 : -1;
          return hurt(sn * sg, cs * sg, 10, 20, 8);
        }
      }
    });
    for (const [x, z] of [[-18, -135], [18, -135], [-18, -157], [18, -157], [0, -146]]) await prop('pillar_2x2x4', null, x, 0, z);
  }
  await stars([[-8, 1.3, -140], [9, 1.3, -150], [-17, 1.3, -148], [17, 1.3, -168]]);
  await walls(Z.spinner, Z.boulder);

  // ================================================================ 6. BOULDER RUN
  ground(Z.boulder);
  for (const [x, z] of [[-5, -184], [5, -184], [0, -197], [-8, -197], [8, -197]]) await prop('pillar_2x2x4', null, x, 0, z); // shelter
  {
    let bt = 1;
    tick((dt) => {
      if (pPos.z > -214 && pPos.z < -168 && (bt -= dt) < 0) {
        bt = 3.2;
        shoot('ball', new THREE.Vector3(rnd(-8, 8), 1.4, -209), new THREE.Vector3(0, 0, 9), { r: 1.35, color: ['red', 'yellow', 'blue'][(Math.random() * 3) | 0], life: 12, density: 0.8, spin: 9 / 1.35 });
      }
    });
  }
  await stars([[-5, 1.3, -186.5], [5, 1.3, -186.5], [0, 1.3, -199.5], [-8, 1.3, -199.5]]);
  await walls(Z.boulder, Z.crusher);

  // ================================================================ 7. CRUSHER HALL
  ground(Z.crusher);
  {
    const crushers = [-219.5, -225, -230.5, -236].map((z, i) => {
      const hw = 8.8, d = 3.5, h = 3;
      const { mesh } = box(0, 4, z, hw * 2, h, d, { color: 0xffffff, map: stripeTex, solid: false });
      mesh.material.map.repeat.set(hw * 2 / 3, 1);
      return { mesh, z, hw, d, h, ph: [0, 0.35, 0.7, 0.15][i], bottom: 3.8 };
    });
    const P = 2.8;
    const yAt = (u) => (u < 0.45 ? 3.8 : u < 0.7 ? 3.8 - ((u - 0.45) / 0.25) * 2.3 : u < 0.75 ? 1.5 - ((u - 0.7) / 0.05) * 1.5 : u < 0.88 ? 0 : ((u - 0.88) / 0.12) * 3.8);
    tick((dt, t) =>
      crushers.forEach((s) => {
        const u = (t / P + s.ph) % 1;
        s.bottom = yAt(u);
        s.mesh.position.set(u > 0.45 && u < 0.7 ? Math.sin(t * 50) * 0.05 : 0, s.bottom + s.h / 2, s.z);
      }),
    );
    L.hazards.push((p) => {
      for (const s of crushers)
        if (Math.abs(p.x) < s.hw + 0.3 && Math.abs(p.z - s.z) < s.d / 2 + 0.3 && s.bottom < p.y + 0.6 && s.bottom + s.h > p.y - CENTER) {
          const sg = p.z >= s.z ? 1 : -1;
          return hurt(0, sg, 9, 35, 6);
        }
    });
    L.avoid.push({ x0: -9, x1: 9, z0: -238, z1: -217 });
  }
  await stars([[0, 1.3, -222], [0, 1.3, -228], [0, 1.3, -233.5]]);
  await walls(Z.crusher, Z.belts);

  // ================================================================ 8. CONVEYOR HALL: belts push you toward lava
  const lavaL = { x0: -17, x1: -12, z0: -243, z1: -277 }, lavaR = { x0: 12, x1: 17, z0: -243, z1: -277 };
  ground(Z.belts, [lavaL, lavaR]);
  for (const [za, zb, dir] of [[-245, -253, 1], [-257, -265, -1], [-269, -277, 1]]) {
    for (let x = -10; x <= 10; x += 4)
      for (let z = za - 2; z > zb; z -= 4) await plat('platform_arrow_4x4x1', 'yellow', x, 0.12, z, { ry: dir > 0 ? -Math.PI / 2 : Math.PI / 2 });
    L.belts.push({ x0: -12, x1: 12, z0: zb, z1: za, vx: dir * 6, vz: 0, top: 0.12 });
    L.avoid.push({ x0: -12, x1: 12, z0: zb, z1: za });
  }
  await stars([[0, 1.3, -251], [0, 1.3, -262], [0, 1.3, -273]]);
  await walls(Z.belts, Z.mortar);

  // ================================================================ 9. MORTAR PLAZA: lobbing turrets + bomb rain
  ground(Z.mortar);
  for (const [x, z] of [[-14, -288], [14, -288], [0, -296], [-16, -302], [16, -302], [-6, -310], [6, -310], [0, -318], [-20, -316], [20, -316]]) await prop('pillar_2x2x4', null, x, 0, z);
  for (const [x, z, d] of [[-21.5, -285, 0], [21.5, -285, 0.8], [-21.5, -300, 1.6], [21.5, -300, 2.4], [-21.5, -315, 3.2], [21.5, -315, 4]])
    await cannon(x, 1, z, { turret: true, T: 1.15, period: 3.4, delay: d, bombs: 0.55, range: 60, target: () => new THREE.Vector3(pPos.x + c.pVel.x * 1.15, pPos.y, pPos.z + c.pVel.z * 1.15) });
  {
    let rt = 1;
    tick((dt) => {
      if (pPos.z < -278 && pPos.z > -322 && (rt -= dt) < 0) {
        rt = 0.7;
        shoot('bomb', new THREE.Vector3(pPos.x + rnd(-9, 9), 15, pPos.z + rnd(-9, 9)), new THREE.Vector3(0, -6, 0), { life: 6 });
      }
    });
  }
  await stars([[-14, 1.3, -291], [14, 1.3, -291], [0, 1.3, -299], [-6, 1.3, -313], [6, 1.3, -313]]);
  await walls(Z.mortar, Z.finish);

  // ================================================================ 10. FINISH: stairs up the middle, ramps up the sides
  ground(Z.finish);
  for (let i = 0; i < 16; i++) {
    const h = 0.3 * (i + 1);
    box(0, h / 2, -328 - i - 0.5, 12, h, 1, { color: 0xf2c46d });
  }
  box(0, 2.4, -348, 32, 4.8, 8, { color: 0xf2c46d, tile: 6 }); // podium (top 4.8)
  ramp(-11, 0, -326, 4.8, -344, 6, 0xf28c6d);
  ramp(11, 0, -326, 4.8, -344, 6, 0xf28c6d);
  await prop('signage_finish_wide', null, 0, 4.8, -349, { solid: false });
  for (const x of [-12, 12]) await prop('flag_A', 'green', x, 4.8, -346, { solid: false });
  await stars([[-11, 3.5, -335], [11, 3.5, -335], [0, 6.2, -345]]);
  // last side walls (no gate): back wall closes the course
  wall(-(Z.finish.hw + 1), Z.finish.z0, Z.finish.z1, 2, Z.finish.wall);
  wall(Z.finish.hw + 1, Z.finish.z0, Z.finish.z1, 2, Z.finish.wall);
  box(0, WALL_H / 2, Z.finish.z1 - 1, 36, WALL_H, 2, { color: Z.finish.wall, shadow: false });
  L.finish = (p, g) => g && p.z < -344 && p.y - CENTER > 4.4;

  // start-side back wall
  box(0, WALL_H / 2, Z.start.z0 + 1, Z.start.hw * 2 + 4, WALL_H, 2, { color: Z.start.wall, shadow: false });
}
