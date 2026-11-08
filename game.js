import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { ui, touch, settings, sensMul, MAP_ID } from './ui.js';
import { buildLand } from './land.js';
import PRELOAD from './preload.json'; // every model file each map uses, so they download in parallel (regenerate: open the map with &dump=1, copy the console line)

const MAP = MAP_ID === 'land' ? 'land' : 'sky';

// ---------- model loading: request everything up front; LoadingManager progress drives the loading screen ----------
const manager = new THREE.LoadingManager();
let prog = 0;
manager.onProgress = (url, loaded, total) => ((prog = Math.max(prog, loaded / total)), ui.loading(prog, url.split('/').pop()));
const loader = new GLTFLoader(manager);
const cache = new Map();
const load = (url) => cache.get(url) ?? (cache.set(url, loader.loadAsync(url)), cache.get(url));
(PRELOAD[MAP] ?? []).forEach(load);

await RAPIER.init();

const PLAT = 'KayKit_Platformer/Assets/gltf/';
const CHAR = 'KayKit_Adventurers_Characters/';
const GRAV = -25;
const world = new RAPIER.World({ x: 0, y: GRAV, z: 0 });
const UP = new THREE.Vector3(0, 1, 0);
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const approach = (v, t, d) => (v < t ? Math.min(v + d, t) : Math.max(v - d, t));

// per-map level state, filled in by the map builders
const L = {
  spawn: { x: 0, y: 0.2, z: 0 },
  tp: [], //                [x, y, z] list for number-key teleports
  ticks: [], //             (dt, time) callbacks
  hazards: [], //           (pPos) callbacks that may call hurt()
  holes: [], //             lava rects {x0,x1,z0,z1,y}: feet below y -> lava hit
  belts: [], //             conveyor rects {x0,x1,z0,z1,vx,vz}
  avoid: [], //             rects where "last safe ground" is never recorded
  crumbleByHandle: new Map(),
  hp: false, //             land map uses a health bar, sky map only knocks you back
  finish: () => false,
};

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fd3ff);
scene.fog = new THREE.Fog(0x8fd3ff, 70, 190);
const cam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 500);
cam.rotation.order = 'YXZ';
scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.7));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 200 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

if (MAP === 'sky') {
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshBasicMaterial({ color: 0x5aa9e6 }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -18;
  scene.add(sea);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  cam.aspect = innerWidth / innerHeight;
  cam.updateProjectionMatrix();
});

// ---------- model helpers ----------
const castAll = (o) => (o.traverse((m) => m.isMesh && (m.castShadow = m.receiveShadow = true)), o);
// color = null -> neutral/ folder (no suffix); platforms originate at bottom-center, 1 unit = 1 block
async function get(name, color) {
  const g = await load(color ? `${PLAT}${color}/${name}_${color}.gltf` : `${PLAT}neutral/${name}.gltf`);
  return castAll(g.scene.clone(true));
}

// ---------- static / kinematic props with colliders ----------
// y = world height of model's base. opts: ry (yaw rad), hull (convex hull, for slopes), solid:false (decor), kinematic, s (scale)
async function prop(name, color, x, y, z, { ry = 0, hull = false, solid = true, kinematic = false, s = 1 } = {}) {
  const o = await get(name, color);
  o.scale.setScalar(s);
  o.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(o);
  const ctr = bb.getCenter(new THREE.Vector3()), half = bb.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  let cd = null;
  if (solid) {
    if (hull) {
      const pts = [], v = new THREE.Vector3();
      o.traverse((m) => {
        if (!m.isMesh) return;
        const a = m.geometry.attributes.position;
        for (let i = 0; i < a.count; i++) v.fromBufferAttribute(a, i).applyMatrix4(m.matrixWorld), pts.push(v.x, v.y, v.z);
      });
      cd = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
    } else cd = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(ctr.x, ctr.y, ctr.z);
  }
  o.position.set(x, y, z);
  o.rotation.y = ry;
  scene.add(o);
  if (!cd) return { obj: o };
  const bd = (kinematic ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.fixed())
    .setTranslation(x, y, z)
    .setRotation({ x: 0, y: Math.sin(ry / 2), z: 0, w: Math.cos(ry / 2) });
  const body = world.createRigidBody(bd);
  world.createCollider(cd.setFriction(0.8), body);
  return { obj: o, body, top: y + bb.max.y };
}
// platform helper: place by its TOP height (height parsed from the AxBxH name)
const plat = (n, c, x, top, z, o) => prop(n, c, x, top - +n.match(/x(\d+)$/)[1], z, o);

// plain colored box (terrain, walls, ramps). (cx,cy,cz) = center. rx/ry/rz rotate it (ramps = rotated boxes).
const checker = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#e4e4e4';
  g.fillRect(0, 0, 32, 32);
  g.fillRect(32, 32, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
function box(cx, cy, cz, w, h, d, { color = 0x888888, rx = 0, ry = 0, rz = 0, tile = 0, solid = true, shadow = true, map = null } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
  if (tile || map) {
    mat.map = (map ?? checker).clone();
    mat.map.repeat.set(w / (tile || 6), d / (tile || 6));
    mat.map.needsUpdate = true;
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(cx, cy, cz);
  mesh.rotation.set(rx, ry, rz);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  scene.add(mesh);
  if (!solid) return { mesh };
  const q = mesh.quaternion;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
  world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setFriction(0.8), body);
  return { mesh, body };
}

// kinematic movers: fn(t) -> {x,y,z}. Player standing on one is carried (see updatePlayer).
const movers = new Map(); // body handle -> {dx,dy,dz}
const moverList = [];
function mover(body, obj, fn) {
  movers.set(body.handle, { dx: 0, dy: 0, dz: 0 });
  moverList.push({ body, obj, fn });
}

// ---------- preload shootable models ----------
const M = {};
for (const c of ['red', 'blue', 'yellow', 'green']) {
  M['ball' + c] = await get('ball', c);
  M['bomb' + c] = await get('bomb_A', c);
}
const COLORS = ['red', 'blue', 'yellow', 'green'];

// ---------- fx ----------
const fx = [], fxGeo = new THREE.SphereGeometry(1, 16, 12);
function flash(p, color, size) {
  const m = new THREE.Mesh(fxGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }));
  m.position.copy(p);
  scene.add(m);
  fx.push({ m, t: 0, size });
}

// ---------- dynamic things (cannonballs, bombs, boulders) ----------
const dyn = [];
function shoot(kind, p, v, { r, life = 12, color, density = 1, spin = null, dmg = null } = {}) {
  const bomb = kind === 'bomb';
  r ??= bomb ? 0.4 : 0.35;
  color ??= COLORS[(Math.random() * 4) | 0];
  const mesh = M[kind + color].clone(true);
  if (!bomb) mesh.scale.setScalar(r);
  scene.add(mesh);
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setLinvel(v.x, v.y, v.z).setCcdEnabled(true).setLinearDamping(0.03).setAngularDamping(0.3));
  if (spin) body.setAngvel({ x: spin, y: 0, z: 0 }, true);
  world.createCollider(RAPIER.ColliderDesc.ball(r).setRestitution(0.45).setFriction(0.8).setDensity(density), body);
  dyn.push({ body, mesh, r, life, bomb, fuse: 2.2, dmg: dmg ?? (r >= 1 ? 30 : 12) });
}
const removeDyn = (i) => {
  world.removeRigidBody(dyn[i].body);
  scene.remove(dyn[i].mesh);
  dyn.splice(i, 1);
};
function explode(p) {
  flash(p, 0xffa030, 4);
  flash(p, 0xfff2b0, 2);
  for (const d of dyn) {
    const q = d.body.translation(), dx = q.x - p.x, dy = q.y - p.y + 0.3, dz = q.z - p.z, dist = Math.hypot(dx, dy, dz);
    if (dist < 5 && dist > 0.01) {
      const k = (1 - dist / 5) * 14 * d.body.mass();
      d.body.applyImpulse({ x: (dx / dist) * k, y: (dy / dist) * k, z: (dz / dist) * k }, true);
    }
  }
  const dx = pPos.x - p.x, dz = pPos.z - p.z, h = Math.hypot(dx, dz) || 1, dist = Math.hypot(dx, pPos.y - p.y, dz);
  if (dist < 4.5) hurt(dx / h, dz / h, 13 * (1 - dist / 6), 20);
}

// ---------- pickups / springs / cannons (shared by both maps) ----------
const pickups = [], springs = [], cannons = [];
let total = 0, got = 0;

async function pickup(kind, color, x, y, z) {
  const o = await get(kind, color);
  o.position.set(x, y, z);
  scene.add(o);
  pickups.push({ o, y, ph: Math.random() * 6 });
  total++;
}
async function spring(x, top, z, power = 21) {
  const o = await prop('spring_pad', 'blue', x, top, z);
  springs.push({ x, z, top: top + 1, obj: o.obj, sq: 0, power });
}

// velocity that hits `to` from `from` in T seconds under world gravity
const ballistic = (from, to, T) => new THREE.Vector3((to.x - from.x) / T, (to.y - from.y) / T - 0.5 * GRAV * T, (to.z - from.z) / T);
// cannon built from pipe models. `top` = top of the crate it stands on (crate is a solid 1x1x1 wood block below it).
async function cannon(x, top, z, { turret = false, target, T = 0.5, period = 2.2, delay = 0, range = 40, bombs = 0.2 }) {
  await prop('platform_wood_1x1x1', null, x, top - 1, z);
  const pivot = new THREE.Group(), bar = new THREE.Group();
  pivot.position.set(x, top + 0.55, z);
  const a = await get('pipe_straight_A', 'red'), b = await get('pipe_end', 'red');
  a.scale.setScalar(0.4);
  b.scale.setScalar(0.4);
  a.position.y = -0.4;
  b.position.y = 0.4;
  bar.add(a, b);
  pivot.add(bar);
  scene.add(pivot);
  if (!turret) pivot.quaternion.setFromUnitVectors(UP, ballistic(pivot.position, target(), T).normalize()); // initial aim
  cannons.push({ pivot, bar, turret, target, T, period, t: period + delay, recoil: 0, range, bombs });
}

// ---------- player ----------
const [gen, mov] = await Promise.all(['General', 'MovementBasic'].map((n) => load(`${CHAR}Animations/gltf/Rig_Medium/Rig_Medium_${n}.glb`)));
const clips = Object.fromEntries([...gen.animations, ...mov.animations].map((c) => [c.name, c]));
const kg = await load(CHAR + 'Characters/gltf/Knight.glb');
const vis = castAll(cloneSkinned(kg.scene));
vis.scale.setScalar(0.5);
vis.traverse((m) => m.isSkinnedMesh && (m.frustumCulled = false));
scene.add(vis);
// weapons on the hand bones (names get sanitized by GLTFLoader: "handslot.r" -> "handslotr")
for (const [slot, file] of [['handslotr', 'sword_1handed'], ['handslotl', 'shield_badge_color']]) {
  const w = castAll((await load(`${CHAR}Assets/gltf/${file}.gltf`)).scene.clone(true));
  vis.getObjectByName(slot)?.add(w);
}

const mixer = new THREE.AnimationMixer(vis);
const once = new Set(['Jump_Start', 'Jump_Land', 'Hit_A']);
const acts = {};
let curName = '', cur = null;
function play(n, fade = 0.12) {
  if (curName === n) return;
  const a = (acts[n] ??= mixer.clipAction(clips[n]));
  if (once.has(n)) (a.setLoop(THREE.LoopOnce, 1), (a.clampWhenFinished = true));
  a.reset().fadeIn(fade).play();
  if (cur && cur !== a) cur.fadeOut(fade);
  cur = a;
  curName = n;
}

const HALF = 0.3, RAD = 0.3, CENTER = HALF + RAD; // capsule center is 0.6 above the feet
const player = { body: world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 50, 0)) };
player.col = world.createCollider(RAPIER.ColliderDesc.capsule(HALF, RAD), player.body);
const kcc = world.createCharacterController(0.02);
kcc.setUp({ x: 0, y: 1, z: 0 });
kcc.enableAutostep(0.35, 0.15, false);
kcc.enableSnapToGround(0.25);
kcc.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
kcc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
kcc.setApplyImpulsesToDynamicBodies(true);
kcc.setCharacterMass(2);

const pPos = new THREE.Vector3(0, CENTER, 0), pVel = new THREE.Vector3(); // pVel = horizontal velocity
let vy = 0, grounded = false, coyote = 0, jumpBuf = 0, jumpsLeft = 2, jumpedAt = -9, hurtT = 0, hitCd = 0, face = Math.PI;
let spawn = L.spawn, lastSafe = L.spawn, safeT = 0, hp = 100, regenT = 0, deaths = 0, finished = false;
let time = 0, runT = 0;

function teleport(p) {
  player.body.setTranslation({ x: p.x, y: p.y + CENTER, z: p.z }, true);
  pPos.set(p.x, p.y + CENTER, p.z);
  pVel.set(0, 0, 0);
  vy = 0;
}
function damage(n) {
  if (!L.hp) return;
  hp -= n;
  regenT = 4;
  if (hp <= 0) {
    deaths++;
    hp = 100;
    teleport(lastSafe);
    ui.toast('Defeated!');
  }
  ui.hp(hp / 100);
}
// knockback (+ damage on the land map)
function hurt(dx, dz, power, dmg = 0, up = 8) {
  if (hitCd > 0 || finished) return;
  pVel.set(dx * power, 0, dz * power);
  vy = up;
  hurtT = 0.45;
  hitCd = 0.9;
  flash(pPos, 0xffffff, 1.2);
  damage(dmg);
}
// lava: damage and put the player back on the last safe ground
function lavaHit() {
  if (hitCd > 0) return;
  hitCd = 0.8;
  flash(pPos, 0xff6a1a, 2);
  damage(25);
  if (hp < 100 || !L.hp) teleport(lastSafe);
  ui.toast('Lava!');
}
const respawn = () => teleport(L.hp ? lastSafe : spawn);

// ---------- input / camera ----------
const keys = {};
let yaw = 0, elev = 0.45, dist = 7, fly = false;
const camT = new THREE.Vector3(0, 1.5, 0);
let state = 'ready'; // ready | play | paused | won
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys[e.code] = true;
  if (e.code === 'Space') (jumpBuf = 0.12), e.preventDefault();
  if (state !== 'play') return;
  if (e.code === 'KeyF') fly = !fly;
  if (e.code === 'KeyR') respawn();
  const tp = L.tp[+e.key - 1]; // number keys: jump to a section of the map (also handy for testing)
  if (tp) (spawn = lastSafe = { x: tp[0], y: tp[1] + 0.2, z: tp[2] }), respawn();
});
addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'Space' && vy > 3.5) vy = 3.5; // variable jump height
});
const lock = () => renderer.domElement.requestPointerLock?.()?.catch?.(() => {});
renderer.domElement.addEventListener('click', () => state === 'play' && document.pointerLockElement !== renderer.domElement && lock());
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.0025 * sensMul();
  elev = clamp(elev + e.movementY * 0.0025 * sensMul() * (settings.invert ? -1 : 1), -0.35, 1.45);
});
addEventListener('wheel', (e) => (dist = clamp(dist + e.deltaY * 0.005, 2.5, 16)));

// touch controls (joystick movement is read in updatePlayer)
touch.onJump = () => (jumpBuf = 0.12);
touch.onJumpEnd = () => vy > 3.5 && (vy = 3.5);
touch.onLook = (dx, dy) => {
  if (state !== 'play') return;
  yaw -= dx * 0.005 * sensMul();
  elev = clamp(elev + dy * 0.005 * sensMul() * (settings.invert ? -1 : 1), -0.35, 1.45);
};
touch.onMenu = () => {
  if (state !== 'play') return;
  state = 'paused';
  ui.panel('Paused', 'RESUME');
};
ui.onResume = () => {
  state = 'play';
  ui.panel('', '', false);
  lock();
};
let wasLocked = false;
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === renderer.domElement) wasLocked = true;
  else if (wasLocked && state === 'play') {
    wasLocked = false;
    state = 'paused';
    ui.panel('Paused', 'RESUME');
  }
});

// ---------- per-frame ----------
function updatePlayer(dt) {
  const t = player.body.translation();
  pPos.set(t.x, t.y, t.z);

  // ground under feet: moving-platform carry, crumbling tiles, safe-ground bookkeeping
  let cx = 0, cy = 0, cz = 0, onStatic = false;
  const hit = world.castRay(new RAPIER.Ray(t, { x: 0, y: -1, z: 0 }), CENTER + 0.3, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, player.col);
  const gh = hit?.collider.parent()?.handle;
  const m = movers.get(gh), cr = L.crumbleByHandle.get(gh);
  if (grounded) {
    if (m) (cx = m.dx), (cy = m.dy), (cz = m.dz);
    if (cr) cr.touched = true;
    onStatic = !m && !cr;
  }
  for (const b of L.belts) // conveyor belts carry like a moving platform
    if (grounded && t.x > b.x0 && t.x < b.x1 && t.z > b.z0 && t.z < b.z1 && t.y - CENTER < (b.top ?? 0) + 0.4) (cx += b.vx * dt), (cz += b.vz * dt);

  // input -> horizontal velocity (camera-relative)
  hitCd -= dt;
  hurtT -= dt;
  const f = clamp((keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0) + touch.y, -1, 1), r = clamp((keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + touch.x, -1, 1);
  if (!fly && hurtT <= 0 && !finished) {
    let ix = -Math.sin(yaw) * f + Math.cos(yaw) * r, iz = -Math.cos(yaw) * f - Math.sin(yaw) * r;
    const len = Math.hypot(ix, iz);
    if (len > 1) (ix /= len), (iz /= len);
    const acc = (grounded ? 70 : 35) * dt;
    pVel.x = approach(pVel.x, ix * 7.5, acc);
    pVel.z = approach(pVel.z, iz * 7.5, acc);
  } else if (grounded) {
    pVel.x = approach(pVel.x, 0, 30 * dt);
    pVel.z = approach(pVel.z, 0, 30 * dt);
  }

  // jump (coyote time + input buffer + double jump)
  coyote = grounded ? 0.1 : coyote - dt;
  if (grounded) jumpsLeft = 2;
  jumpBuf -= dt;
  if (jumpBuf > 0 && !fly && hurtT <= 0 && !finished && (coyote > 0 || jumpsLeft > 0)) {
    if (coyote <= 0) jumpsLeft = Math.min(jumpsLeft, 1);
    vy = 11.5;
    jumpsLeft--;
    coyote = 0;
    jumpBuf = 0;
    jumpedAt = runT;
    curName = ''; // restart Jump_Start for double jumps
  }
  for (const s of springs)
    if (grounded && Math.abs(pPos.x - s.x) < 0.85 && Math.abs(pPos.z - s.z) < 0.85 && pPos.y - CENTER > s.top - 0.2) {
      vy = s.power;
      jumpsLeft = 1;
      s.sq = 1;
      jumpedAt = runT;
      curName = '';
      flash(new THREE.Vector3(s.x, s.top, s.z), 0xffffff, 1.4);
    }
  vy = Math.max(vy + GRAV * dt, -40);

  // character controller move
  const want = { x: pVel.x * dt + cx, y: vy * dt + cy, z: pVel.z * dt + cz };
  kcc.computeColliderMovement(player.col, want);
  const mv = kcc.computedMovement();
  grounded = kcc.computedGrounded();
  if (want.y > 0 && mv.y < want.y - 1e-4) vy = Math.min(vy, 0); // bonked ceiling
  if (grounded && vy < 0) vy = 0;
  player.body.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z });

  // balls hitting the player (pre-step so we still have the incoming velocity)
  for (const d of dyn) {
    const p = d.body.translation(), v = d.body.linvel(), sp = Math.hypot(v.x, v.y, v.z);
    const cyy = clamp(p.y, t.y - HALF, t.y + HALF);
    if (sp > 4 && Math.hypot(p.x - t.x, p.y - cyy, p.z - t.z) < d.r + RAD + 0.25 && !d.bomb) {
      const h = Math.hypot(v.x, v.z) || 1;
      hurt(v.x / h, v.z / h, clamp(sp * 0.7, 7, 15), d.dmg);
    }
  }

  // map hazards (spikes, spinners, crushers...) + lava
  for (const h of L.hazards) h(pPos);
  const feet = pPos.y - CENTER;
  for (const h of L.holes) if (pPos.x > h.x0 && pPos.x < h.x1 && pPos.z > h.z0 && pPos.z < h.z1 && feet < h.y) lavaHit();
  if (t.y < -16) respawn(); // sky map: fell off

  // "last safe ground" (replaces checkpoints on the land map): only on plain solid ground away from traps
  if (onStatic && (safeT -= dt) <= 0 && !L.avoid.some((a) => t.x > a.x0 - 1.5 && t.x < a.x1 + 1.5 && t.z > a.z0 - 1.5 && t.z < a.z1 + 1.5)) { // rects have z0 < z1
    lastSafe = { x: t.x, y: feet + 0.1, z: t.z };
    safeT = 0.3;
  }
  if (L.hp && regenT <= 0 && hp < 100) (hp = Math.min(100, hp + 6 * dt)), ui.hp(hp / 100);
  regenT -= dt;

  if (!finished && L.finish(pPos, grounded)) {
    finished = true;
    state = 'won';
    document.exitPointerLock?.();
    const rating = 1 + (got >= total * 0.5 ? 1 : 0) + (got >= total ? 1 : 0);
    ui.win({ time: runT, got, total, deaths: L.hp ? deaths : null, rating });
  }

  // visuals
  vis.position.set(pPos.x, feet, pPos.z);
  const sp = Math.hypot(pVel.x, pVel.z);
  if (sp > 0.5 && hurtT <= 0) face += Math.atan2(Math.sin(Math.atan2(pVel.x, pVel.z) - face), Math.cos(Math.atan2(pVel.x, pVel.z) - face)) * Math.min(1, dt * 14);
  vis.rotation.y = face;
  let a = 'Idle_A';
  if (hurtT > 0) a = 'Hit_A';
  else if (!grounded) a = runT - jumpedAt < 0.5 ? 'Jump_Start' : 'Jump_Idle';
  else if (sp > 0.5) a = 'Running_A';
  play(a);
  mixer.update(dt);
}

function updateCamera(dt) {
  cam.rotation.set(-elev, yaw, 0);
  if (fly) {
    const sp = (keys.ShiftLeft ? 40 : 14) * dt;
    const fw = new THREE.Vector3(0, 0, -1).applyEuler(cam.rotation), rt = new THREE.Vector3(1, 0, 0).applyEuler(cam.rotation);
    cam.position.addScaledVector(fw, ((keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0)) * sp);
    cam.position.addScaledVector(rt, ((keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0)) * sp);
    cam.position.y += ((keys.Space ? 1 : 0) - (keys.KeyC ? 1 : 0)) * sp;
    return;
  }
  camT.lerp(new THREE.Vector3(pPos.x, pPos.y + 0.6, pPos.z), 1 - Math.exp(-14 * dt));
  const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(elev), Math.sin(elev), Math.cos(yaw) * Math.cos(elev));
  const h = world.castRay(new RAPIER.Ray(camT, dir), dist, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, player.col);
  const d = h ? Math.max(0.8, h.timeOfImpact - 0.3) : dist; // keep camera out of walls
  cam.position.copy(camT).addScaledVector(dir, d);
}

function update(dt) {
  time += dt;
  if (!finished) runT += dt;
  const focus = fly ? cam.position : pPos;

  for (const m of moverList) {
    const o = m.body.translation(), p = m.fn(time), d = movers.get(m.body.handle);
    d.dx = p.x - o.x;
    d.dy = p.y - o.y;
    d.dz = p.z - o.z;
    m.body.setNextKinematicTranslation(p);
    m.obj.position.set(p.x, p.y, p.z);
  }

  updatePlayer(dt);

  // cannons
  for (const c of cannons) {
    c.recoil = Math.max(0, c.recoil - dt * 4);
    c.bar.position.y = -0.25 * c.recoil;
    const near = c.pivot.position.distanceTo(focus) < c.range;
    if (c.turret) {
      if (!near) continue;
      const v = ballistic(c.pivot.position, c.target(), c.T);
      c.pivot.quaternion.slerp(new THREE.Quaternion().setFromUnitVectors(UP, v.clone().normalize()), 1 - Math.exp(-8 * dt));
    }
    if ((c.t -= dt) > 0 || !near) continue;
    if (c.turret && c.pivot.position.distanceTo(pPos) < 6) continue;
    c.t = c.period;
    const v = ballistic(c.pivot.position, c.target(), c.T);
    const dir = v.clone().normalize();
    c.pivot.quaternion.setFromUnitVectors(UP, dir);
    const muzzle = c.pivot.position.clone().addScaledVector(dir, 0.9);
    shoot(Math.random() < c.bombs ? 'bomb' : 'ball', muzzle, v);
    flash(muzzle, 0xffe9a0, 0.7);
    c.recoil = 1;
  }

  for (const f of L.ticks) f(dt, time);

  world.timestep = dt; // ponytail: variable timestep (capped 1/30); switch to fixed-step accumulator if physics jitter shows up
  world.step();

  for (let i = dyn.length - 1; i >= 0; i--) {
    const d = dyn[i], p = d.body.translation(), q = d.body.rotation();
    d.mesh.position.set(p.x, p.y, p.z);
    d.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    d.life -= dt;
    if (d.bomb && (d.fuse -= dt) < 0) (explode(new THREE.Vector3(p.x, p.y, p.z)), removeDyn(i));
    else if (d.bomb) d.mesh.scale.setScalar(1 + 0.12 * Math.sin(time * (d.fuse < 1 ? 40 : 14)));
    if (d.life < 0 || p.y < -20) removeDyn(i);
  }
  for (let i = fx.length - 1; i >= 0; i--) {
    const e = fx[i];
    e.t += dt / 0.35;
    e.m.scale.setScalar(e.size * (0.3 + e.t * 0.7));
    e.m.material.opacity = 0.9 * (1 - e.t);
    if (e.t >= 1) (scene.remove(e.m), e.m.material.dispose(), fx.splice(i, 1));
  }
  for (const s of springs) {
    s.sq = Math.max(0, s.sq - dt * 3);
    s.obj.scale.y = 1 - 0.4 * s.sq;
  }
  for (let i = pickups.length - 1; i >= 0; i--) {
    const k = pickups[i];
    k.o.rotation.y += dt * 2.5;
    k.o.position.y = k.y + Math.sin(time * 3 + k.ph) * 0.15;
    if (k.o.position.distanceTo(pPos) < 1.1) {
      flash(k.o.position, 0xffe14d, 1.2);
      scene.remove(k.o);
      pickups.splice(i, 1);
      got++;
      ui.stars(got, total);
    }
  }

  updateCamera(dt);
  sun.position.set(pPos.x + 30, pPos.y + 60, pPos.z + 20);
  sun.target.position.copy(pPos);
  ui.time(runT);
}

// =====================================================================================
// MAP 1: sky course (floating platforms) — unchanged layout
// =====================================================================================
async function buildSky() {
  L.tp = [[0, 0, 0], [0, 2, -19], [0, 6, -29], [0, 6, -47], [0, 6, -66]];
  const checkpoints = [];

  await plat('platform_6x6x1', 'green', 0, 0, 0);
  await prop('cone', 'red', -2.5, 0, 1.5);
  await prop('cone', 'red', 2.5, 0, 1.5);
  await prop('signage_arrow_stand', 'red', 0, 0, -2.2);
  // stepping stones
  await plat('platform_2x2x1', 'blue', 0, 0, -6.5);
  await plat('platform_2x2x1', 'yellow', 2.5, 1, -10);
  await plat('platform_2x2x1', 'red', -1, 2, -13.5);
  // hub + checkpoint
  await plat('platform_6x6x1', 'blue', 0, 2, -19);
  for (const x of [-2.9, 2.9]) await prop('barrier_1x1x2', 'blue', x, 2, -21.5);
  // slope up (model rises toward -Z natively)
  await prop('platform_slope_4x4x4', 'yellow', 0, 2, -24, { hull: true });
  // upper deck with spring + bonus island
  await plat('platform_6x6x1', 'green', 0, 6, -29);
  await plat('platform_2x2x1', 'yellow', -5.5, 10, -29);
  // moving platform bridge (z swings -35..-41)
  const mp = await prop('platform_4x2x1', 'red', 0, 5, -38, { kinematic: true });
  mover(mp.body, mp.obj, (t) => ({ x: 0, y: 5, z: -38 + 3 * Math.sin(t * 0.8) }));
  // cannon arena
  await plat('platform_6x6x1', 'blue', 0, 6, -47);
  // boulder lane
  for (const z of [-52, -56, -60]) await plat('platform_4x4x1', 'yellow', 0, 6, z);
  await prop('arch_wide', 'red', 0, 6, -61, { solid: false });
  // finish
  await plat('platform_6x6x1', 'green', 0, 6, -66);
  await prop('signage_finish_wide', null, 0, 6, -68.5);

  async function checkpoint(x, top, z) {
    const on = await get('flag_A', 'green'), off = await get('flag_A', 'red');
    on.position.set(x, top, z);
    off.position.set(x, top, z);
    on.visible = false;
    scene.add(on, off);
    checkpoints.push({ x, top, z, on, off });
  }
  await checkpoint(-2.2, 2, -17.5);
  await checkpoint(-2.2, 6, -27);
  await checkpoint(2.5, 6, -49.5);
  L.ticks.push(() => {
    for (const c of checkpoints)
      if (!c.on.visible && Math.hypot(pPos.x - c.x, pPos.z - c.z) < 2.5 && Math.abs(pPos.y - CENTER - c.top) < 1.5) {
        for (const o of checkpoints) (o.on.visible = false), (o.off.visible = true);
        c.on.visible = true;
        c.off.visible = false;
        spawn = { x: c.x - Math.sign(c.x) * 1.5, y: c.top + 0.2, z: c.z };
        flash(new THREE.Vector3(c.x, c.top + 1, c.z), 0x66ff88, 2.2);
      }
  });

  await spring(-2, 6, -29);

  for (const [x, y, z] of [[0, 1.4, -6.5], [2.5, 2.4, -10], [-1, 3.4, -13.5], [2, 3.4, -19], [0, 5.5, -24], [2, 7.4, -30], [0, 7.4, -47], [0, 7.4, -54], [0, 7.4, -58]])
    await pickup('star', 'yellow', x, y, z);
  for (const [x, y, z] of [[-5.5, 11.4, -28.4], [-5.5, 11.4, -29.6], [0, 7.3, -38]]) await pickup('diamond', 'blue', x, y, z);

  await cannon(-3.5, 6, -45, { target: () => new THREE.Vector3(3.5, 6.75, -45 + rnd(-1.5, 1.5)), T: 0.45, period: 2.4 });
  await cannon(3.5, 6, -47, { target: () => new THREE.Vector3(-3.5, 6.75, -47 + rnd(-1.5, 1.5)), T: 0.45, period: 2.4, delay: 1.2 });
  await cannon(-3.5, 6, -49.5, { turret: true, T: 1.1, period: 3.2, target: () => new THREE.Vector3(pPos.x + pVel.x * 1.1, pPos.y + 0.2, pPos.z + pVel.z * 1.1) });

  // boulder gate at the end of the lane
  let boulderT = 3;
  L.ticks.push((dt) => {
    if ((boulderT -= dt) < 0) {
      boulderT = 7;
      shoot('ball', new THREE.Vector3(0, 7.15, -61), new THREE.Vector3(0, 0, 6), { r: 1, color: 'red', life: 14, density: 0.8, spin: 6 });
    }
  });
  L.finish = (p, g) => p.z < -64 && g;
}

// =====================================================================================
// MAP 2: land of traps (see land.js)
// =====================================================================================
const ctx = { THREE, RAPIER, scene, world, L, get, prop, plat, box, mover, shoot, flash, cannon, ballistic, pickup, spring, rnd, clamp, hurt, pPos, pVel, CENTER, getTime: () => time };

ui.loading(prog, 'building level…');
if (MAP === 'land') {
  L.hp = true;
  await buildLand(ctx);
} else await buildSky();

if (location.search.includes('dump=1')) console.log('PRELOAD ' + JSON.stringify({ [MAP]: [...cache.keys()] }));
spawn = lastSafe = L.spawn;
teleport(spawn);
camT.set(spawn.x, spawn.y + 1, spawn.z);
ui.loadingDone();
ui.showHud(L.hp);
ui.stars(0, total);
ui.hp(1);
ui.panel('Ready?', 'PLAY');

let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;
  if (state === 'play' || state === 'won') update(dt); // 'won' keeps the world alive behind the result panel
  else updateCamera(dt);
  renderer.render(scene, cam);
});
