// DOM UI layer: menu, HUD, pause/win panels. All art comes from UI_Pack via CSS (see index.html); this only wires behaviour.
const $ = (s) => document.querySelector(s);
const show = (el, on = true) => el.classList.toggle('hide', !on);
export const MAP_ID = new URLSearchParams(location.search).get('map');
export const MAPS = { sky: 'Sky Course', land: 'Land of Traps' };

const stored = (() => { try { return JSON.parse(localStorage.getItem('settings') || '{}'); } catch { return {}; } })();
export const settings = { sens: 0.5, invert: false, name: '', ...stored }; // sens is the slider position 0..1
const save = () => { try { localStorage.setItem('settings', JSON.stringify(settings)); } catch {} };
export const sensMul = () => 0.2 + 1.6 * settings.sens;
export const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
export const best = (id) => +(localStorage.getItem('best_' + id) || 0) || null;

function slider(el, v, cb) {
  el.style.setProperty('--v', v);
  const move = (e) => {
    const r = el.getBoundingClientRect(), x = Math.min(1, Math.max(0, (e.clientX - r.left - 14) / (r.width - 28)));
    el.style.setProperty('--v', x);
    cb(x);
  };
  el.addEventListener('pointerdown', (e) => (el.setPointerCapture(e.pointerId), move(e), (el.onpointermove = move)));
  el.addEventListener('pointerup', () => (el.onpointermove = null));
}

// ---- pause panel controls ----
slider($('#sens'), settings.sens, (x) => ((settings.sens = x), save()));
const inv = $('#invert');
inv.classList.toggle('on', settings.invert);
inv.onclick = () => (inv.classList.toggle('on'), (settings.invert = inv.classList.contains('on')), save());
document.querySelectorAll('.tomenu').forEach((b) => (b.onclick = () => (location.search = '')));
$('#restart').onclick = $('#again').onclick = () => location.reload();

// ---- main menu (only when no ?map=) ----
if (!MAP_ID) {
  let sel = 'sky';
  const menu = $('#menu');
  show(menu);
  const name = $('#name');
  name.value = settings.name;
  name.oninput = () => ((settings.name = name.value.trim()), save());
  const cards = [...document.querySelectorAll('.map')];
  const paint = () =>
    cards.forEach((c) => {
      c.classList.toggle('green', c.dataset.map === sel);
      c.classList.toggle('grey', c.dataset.map !== sel);
      const b = best(c.dataset.map);
      c.querySelector('.mbest').innerHTML = b ? `<img src="UI_Pack/Yellow/star.svg"> Best ${fmt(b)}` : 'No time yet';
    });
  cards.forEach((c) => (c.onclick = () => ((sel = c.dataset.map), paint())));
  $('#go').onclick = () => (location.search = '?map=' + sel);
  paint();
}

// ---- touch controls: joystick (left), jump (right), drag anywhere else to look, menu button (top-left) ----
export const touch = { x: 0, y: 0, onJump: null, onJumpEnd: null, onLook: null, onMenu: null }; // x right, y forward, -1..1
{
  const joy = $('#joy'), knob = $('#joy-knob'), R = 55;
  let jid = null, c = null;
  const mv = (e) => {
    let dx = e.clientX - c.x, dy = e.clientY - c.y;
    const l = Math.hypot(dx, dy);
    if (l > R) (dx *= R / l), (dy *= R / l);
    knob.style.transform = `translate(${dx}px,${dy}px)`;
    const m = Math.hypot(dx, dy) / R; // 15% dead zone
    touch.x = m < 0.15 ? 0 : dx / R;
    touch.y = m < 0.15 ? 0 : -dy / R;
  };
  const end = (e) => {
    if (e.pointerId !== jid) return;
    jid = null;
    touch.x = touch.y = 0;
    knob.style.transform = '';
  };
  joy.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    jid = e.pointerId;
    joy.setPointerCapture(jid);
    const r = joy.getBoundingClientRect();
    c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    mv(e);
  });
  joy.addEventListener('pointermove', (e) => e.pointerId === jid && mv(e));
  joy.addEventListener('pointerup', end);
  joy.addEventListener('pointercancel', end);

  const jump = $('#t-jump');
  jump.addEventListener('pointerdown', (e) => (e.preventDefault(), jump.classList.add('down'), touch.onJump?.()));
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) jump.addEventListener(ev, () => (jump.classList.remove('down'), touch.onJumpEnd?.()));

  const look = $('#look');
  let lid = null, lx = 0, ly = 0;
  look.addEventListener('pointerdown', (e) => ((lid = e.pointerId), look.setPointerCapture(lid), (lx = e.clientX), (ly = e.clientY)));
  look.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lid) return;
    touch.onLook?.(e.clientX - lx, e.clientY - ly);
    lx = e.clientX;
    ly = e.clientY;
  });
  for (const ev of ['pointerup', 'pointercancel']) look.addEventListener(ev, () => (lid = null));
  $('#t-menu').onclick = () => touch.onMenu?.();
}
// mobile OS only (Android / iOS / iPadOS), so touchscreen laptops keep mouse+keyboard. ?touch=1 forces it on for testing.
const ua = navigator.userAgent;
const wantTouch =
  navigator.userAgentData?.mobile === true ||
  /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
  (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) || // iPadOS reports as a Mac
  /[?&]touch=1/.test(location.search);

let toastT = 0;
export const ui = {
  onResume: null,
  showHud(withHp) {
    show($('#hud'));
    show($('#hud-hp'), withHp);
    show($('#touch'), wantTouch);
    document.body.classList.toggle('touch', wantTouch);
  },
  stars: (got, total) => ($('#stars').textContent = `${got}/${total}`),
  time: (t) => ($('#hud-time').textContent = fmt(t)),
  hp: (f) => $('#hp').style.setProperty('--v', Math.max(0, f)),
  hint: (on) => show($('#hint'), on),
  toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('on'), 900);
  },
  panel(title, label, on = true) {
    $('#pause-title').textContent = title;
    $('#resume-label').textContent = label;
    show($('#pause'), on);
  },
  win({ time, got, total, deaths, rating }) {
    const prev = best(MAP_ID);
    const record = !prev || time < prev;
    if (record) try { localStorage.setItem('best_' + MAP_ID, time); } catch {}
    $('#win-title').textContent = settings.name ? `Nice run, ${settings.name}!` : 'Course Complete!';
    $('#win-stars').innerHTML = [0, 1, 2].map((i) => `<img src="UI_Pack/${i < rating ? 'Yellow/star' : 'Grey/star_outline'}.svg">`).join('');
    $('#win-line1').innerHTML = `Time <b>${fmt(time)}</b>${record ? ' · new best!' : ` · best ${fmt(prev)}`}`;
    $('#win-line2').innerHTML = `Collected <b>${got}/${total}</b>` + (deaths != null ? ` · Defeats <b>${deaths}</b>` : '');
    show($('#win'));
  },
};
$('#resume').onclick = () => ui.onResume?.();
