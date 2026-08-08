import { init } from '@thorvg/webcanvas';

const WIDTH = 900;
const HEIGHT = 560;
const MIN_AREA = 60;
const DAMPING = 0.97;
const DRIFT_SPEED = 12;
const DRIFT_STOP = 0.8;
const KNIFE_LEN = 300;
const ROT_SPEED = 2.4;
const CUT_COVERAGE = 0.66;
const HANDLE_RATIO = 0.16;
const STAGE_TIME = 30;
//Placeholders. Replace once we know what a real run looks like.
const STARS = [70, 160, 300];
const GATHER_PUSH = 1.0;

//Parallel blades that all cut on one press.
const KNIFE_SETS = [
  { scale: 1.0, count: 1, gap: 0 },
  { scale: 0.61, count: 2, gap: 34 },
  { scale: 0.44, count: 3, gap: 26 },
];

const FLING_CHANCE = 0.125;
const FLING_BOOST = 4.5;

type Pt = { x: number; y: number };
type Piece = { outline: Pt[]; r: number; g: number; b: number; vx: number; vy: number };

//Sign tells which side of the line ab the point p lies on.
function side(a: Pt, b: Pt, p: Pt) {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

//Shoelace formula.
function area(points: Pt[]) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return Math.abs(sum) * 0.5;
}

//Keeps only the half-plane on one side of the line ab. (Sutherland-Hodgman)
function clipHalf(points: Pt[], a: Pt, b: Pt, positive: boolean) {
  const out: Pt[] = [];
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    const next = points[(i + 1) % points.length];
    let dCur = side(a, b, cur);
    let dNext = side(a, b, next);
    if (!positive) { dCur = -dCur; dNext = -dNext; }

    if (dCur >= 0) out.push(cur);

    if ((dCur > 0 && dNext < 0) || (dCur < 0 && dNext > 0)) {
      const t = dCur / (dCur - dNext);
      out.push({
        x: cur.x + t * (next.x - cur.x),
        y: cur.y + t * (next.y - cur.y),
      });
    }
  }
  return out;
}

//How far along the blade direction a point sits.
function along(p: Pt, origin: Pt, dx: number, dy: number) {
  return (p.x - origin.x) * dx + (p.y - origin.y) * dy;
}

//The blade cuts when the sharp part covers enough of the chord it would carve.
function bladeCuts(outline: Pt[], origin: Pt, dx: number, dy: number, lo0: number, hi0: number) {
  const a = { x: origin.x - dx * 1000, y: origin.y - dy * 1000 };
  const b = { x: origin.x + dx * 1000, y: origin.y + dy * 1000 };

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < outline.length; i++) {
    const cur = outline[i];
    const next = outline[(i + 1) % outline.length];
    const dCur = side(a, b, cur);
    const dNext = side(a, b, next);
    if ((dCur > 0) === (dNext > 0)) continue;

    const t = dCur / (dCur - dNext);
    const hit = {
      x: cur.x + t * (next.x - cur.x),
      y: cur.y + t * (next.y - cur.y),
    };
    const s = along(hit, origin, dx, dy);
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }

  if (hi <= lo) return false;

  const covered = Math.min(hi, hi0) - Math.max(lo, lo0);
  if (covered <= 0) return false;

  return covered >= (hi - lo) * CUT_COVERAGE;
}

function clamp(v: number) {
  return Math.max(45, Math.min(245, Math.round(v)));
}

function jitter(channel: number) {
  return clamp(channel + (Math.random() - 0.5) * 44);
}

async function main() {
  const TVG: any = await init({
    renderer: 'gl',
    locateFile: () => import.meta.env.BASE_URL + 'thorvg.wasm',
  });

  const canvas = new TVG.Canvas('#canvas', { width: WIDTH, height: HEIGHT });

  //Start with a convex pentagon.
  const pieces: Piece[] = [];
  const first: Piece = { outline: [], r: 230, g: 200, b: 90, vx: 0, vy: 0 };
  for (let i = 0; i < 5; i++) {
    const angle = -Math.PI / 2 + i * (Math.PI * 2 / 5);
    first.outline.push({
      x: WIDTH / 2 + 170 * Math.cos(angle),
      y: HEIGHT / 2 + 170 * Math.sin(angle),
    });
  }
  pieces.push(first);

  const el = document.querySelector('#canvas') as HTMLCanvasElement;
  const countEl = document.querySelector('#count') as HTMLElement;
  const timerEl = document.querySelector('#timer') as HTMLElement;
  const resultEl = document.querySelector('#result') as HTMLElement;
  const starsEl = document.querySelector('#stars') as HTMLElement;
  const finalEl = document.querySelector('#final') as HTMLElement;

  let timeLeft = STAGE_TIME;
  let running = true;

  function resetStage() {
    pieces.length = 0;
    const start: Piece = { outline: [], r: 230, g: 200, b: 90, vx: 0, vy: 0 };
    for (let i = 0; i < 5; i++) {
      const angle = -Math.PI / 2 + i * (Math.PI * 2 / 5);
      start.outline.push({
        x: WIDTH / 2 + 170 * Math.cos(angle),
        y: HEIGHT / 2 + 170 * Math.sin(angle),
      });
    }
    pieces.push(start);

    timeLeft = STAGE_TIME;
    running = true;
    resultEl.classList.remove('show');
    timerEl.classList.remove('low');
    countEl.textContent = '1';
  }

  function endStage() {
    running = false;
    const n = pieces.length;
    let earned = 0;
    for (const t of STARS) if (n >= t) earned++;
    starsEl.textContent = '★'.repeat(earned) + '☆'.repeat(3 - earned);
    finalEl.textContent = n + ' pieces';
    resultEl.classList.add('show');
    console.log('final: ' + n);
  }

  (document.querySelector('#again') as HTMLElement)
    .addEventListener('click', resetStage);

  let cursor: Pt = { x: WIDTH / 2, y: HEIGHT / 2 };
  let knifeAngle = 0;
  let knifeSet = 0;
  let rotating = false;
  let sweeping = false;


  function position(e: PointerEvent): Pt {
    const rect = el.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width * WIDTH,
      y: (e.clientY - rect.top) / rect.height * HEIGHT,
    };
  }

  //Otherwise right-click opens the browser menu instead of turning the blade.
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  el.addEventListener('pointermove', (e) => {
    const next = position(e);

    //Left button held: works even while the right button is down.
    const leftDown = (e.buttons & 1) !== 0;
    if (leftDown && !sweeping) {
      sweeping = true;
      cursor = next;
      chop();
      return;
    }
    if (!leftDown) sweeping = false;

    if (sweeping) gather(cursor, next);
    cursor = next;
  });

  el.addEventListener('pointerdown', (e) => {
    cursor = position(e);
    if (e.button === 2) {
      rotating = true;
    } else if (e.button === 0) {
      sweeping = true;
      el.setPointerCapture(e.pointerId);
      chop();
    }
  });

  el.addEventListener('pointerup', (e) => {
    if (e.button === 2) rotating = false;
    if (e.button === 0) sweeping = false;
  });

  //Backup for laptops without a mouse.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); rotating = true; }
    if (e.code === 'Digit1') knifeSet = 0;
    if (e.code === 'Digit2') knifeSet = 1;
    if (e.code === 'Digit3') knifeSet = 2;
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') rotating = false;
  });

  //Each blade of the current set, as [tail, tip] pairs.
  function bladeLines(): [Pt, Pt][] {
    const set = KNIFE_SETS[knifeSet];
    const dx = Math.cos(knifeAngle);
    const dy = Math.sin(knifeAngle);
    const nx = -dy;
    const ny = dx;
    const half = KNIFE_LEN * set.scale / 2;

    const lines: [Pt, Pt][] = [];
    const spread = (set.count - 1) / 2;
    for (let i = 0; i < set.count; i++) {
      const off = (i - spread) * set.gap;
      const ox = cursor.x + nx * off;
      const oy = cursor.y + ny * off;
      lines.push([
        { x: ox - dx * half, y: oy - dy * half },
        { x: ox + dx * half, y: oy + dy * half },
      ]);
    }
    return lines;
  }

  //Dragging the blade sideways sweeps pieces along with it.
  function gather(from: Pt, to: Pt) {
    if (!running) return;

    const mx = to.x - from.x;
    const my = to.y - from.y;
    const moved = Math.hypot(mx, my);
    if (moved < 0.5) return;

    const dx = Math.cos(knifeAngle);
    const dy = Math.sin(knifeAngle);
    const nx = -dy;
    const ny = dx;

    //Only motion across the blade pushes; sliding along it does nothing.
    const shove = mx * nx + my * ny;
    if (Math.abs(shove) < 0.5) return;

    const set = KNIFE_SETS[knifeSet];
    const half = KNIFE_LEN * set.scale / 2;
    const reach = (set.count - 1) * set.gap / 2 + 22;

    for (const piece of pieces) {
      let cx = 0, cy = 0;
      for (const p of piece.outline) { cx += p.x; cy += p.y; }
      cx /= piece.outline.length;
      cy /= piece.outline.length;

      const rx = cx - to.x;
      const ry = cy - to.y;

      //Distance along the blade, and perpendicular to it.
      const t = rx * dx + ry * dy;
      const s = rx * nx + ry * ny;
      if (Math.abs(t) > half) continue;
      if (Math.abs(s) > reach) continue;

      //Push only what is in front of the sweep, not behind it.
      if (s * shove > 0) continue;

      const delta = shove * GATHER_PUSH;
      for (const p of piece.outline) {
        p.x += nx * delta;
        p.y += ny * delta;
      }
      piece.vx = 0;
      piece.vy = 0;
    }
  }

  function chop() {
    if (!running) return;
    const set = KNIFE_SETS[knifeSet];
    const dx = Math.cos(knifeAngle);
    const dy = Math.sin(knifeAngle);
    const nx = -dy;
    const ny = dx;

    //The handle end is decoration, so only the sharp part counts.
    const full = KNIFE_LEN * set.scale;
    const half = full / 2;
    const edgeBack = -half + full * HANDLE_RATIO;

    for (const [a, b] of bladeLines()) {
      const origin = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const result: Piece[] = [];

      for (const piece of pieces) {
        if (!bladeCuts(piece.outline, origin, dx, dy, edgeBack, half)) {
          result.push(piece);
          continue;
        }

        const left = clipHalf(piece.outline, a, b, true);
        const right = clipHalf(piece.outline, a, b, false);

        //The line missed, or would only shave a sliver off.
        if (left.length < 3 || right.length < 3 ||
          area(left) < MIN_AREA || area(right) < MIN_AREA) {
          result.push(piece);
          continue;
        }

        //Every so often a piece goes flying, so there is a reason to gather.
        const fling = Math.random() < FLING_CHANCE ? FLING_BOOST : 1;
        const push = (3 + Math.random() * 4) * DRIFT_SPEED * fling;
        result.push({
          outline: left,
          r: jitter(piece.r), g: jitter(piece.g), b: jitter(piece.b),
          vx: nx * push, vy: ny * push,
        });
        result.push({
          outline: right,
          r: jitter(piece.r), g: jitter(piece.g), b: jitter(piece.b),
          vx: -nx * push, vy: -ny * push,
        });
      }

      pieces.length = 0;
      pieces.push(...result);
    }

    countEl.textContent = String(pieces.length);
  }

  let lastTime = 0;

  function animate(time: number) {

    const dt = lastTime === 0 ? 0.016 : Math.min((time - lastTime) / 1000, 0.1);
    lastTime = time;

    if (running) {
      timeLeft -= dt;
      if (timeLeft <= 0) {
        timeLeft = 0;
        endStage();
      }
      timerEl.textContent = String(Math.ceil(timeLeft));
      if (timeLeft <= 5) timerEl.classList.add('low');
    }
    if (rotating) knifeAngle += ROT_SPEED * dt;

    //Move the pieces that are still drifting.
    for (const piece of pieces) {
      if (Math.abs(piece.vx) < DRIFT_STOP && Math.abs(piece.vy) < DRIFT_STOP) {
        piece.vx = 0;
        piece.vy = 0;
        continue;
      }
      for (const p of piece.outline) {
        p.x += piece.vx * dt;
        p.y += piece.vy * dt;
      }
      piece.vx *= DAMPING;
      piece.vy *= DAMPING;

      //Pieces bounce off the edge of the board instead of escaping.
      let cx = 0, cy = 0;
      for (const p of piece.outline) { cx += p.x; cy += p.y; }
      cx /= piece.outline.length;
      cy /= piece.outline.length;

      const M = 40;
      if (cx < M && piece.vx < 0) piece.vx *= -0.4;
      if (cx > WIDTH - M && piece.vx > 0) piece.vx *= -0.4;
      if (cy < M && piece.vy < 0) piece.vy *= -0.4;
      if (cy > HEIGHT - M && piece.vy > 0) piece.vy *= -0.4;
    }

    canvas.clear();

    for (const piece of pieces) {
      //Shadow first, so stacked pieces visibly darken.
      const shadow = new TVG.Shape();
      shadow.moveTo(piece.outline[0].x + 4, piece.outline[0].y + 5);
      for (let i = 1; i < piece.outline.length; i++) {
        shadow.lineTo(piece.outline[i].x + 4, piece.outline[i].y + 5);
      }
      shadow.close();
      shadow.fill(40, 22, 10, 70);
      canvas.add(shadow);

      const shape = new TVG.Shape();
      shape.moveTo(piece.outline[0].x, piece.outline[0].y);
      for (let i = 1; i < piece.outline.length; i++) {
        shape.lineTo(piece.outline[i].x, piece.outline[i].y);
      }
      shape.close();
      shape.fill(piece.r, piece.g, piece.b, 255);
      shape.stroke({ width: 2, color: [14, 14, 18, 255] });
      canvas.add(shape);
    }

    for (const [a, b] of bladeLines()) {
      const blade = new TVG.Shape();
      blade.moveTo(a.x, a.y);
      blade.lineTo(b.x, b.y);
      blade.stroke({ width: 7, color: [225, 228, 235, 235] });
      canvas.add(blade);

      const hx = a.x + (b.x - a.x) * HANDLE_RATIO;
      const hy = a.y + (b.y - a.y) * HANDLE_RATIO;
      const handle = new TVG.Shape();
      handle.moveTo(a.x, a.y);
      handle.lineTo(hx, hy);
      handle.stroke({ width: 13, color: [92, 58, 38, 255] });
      canvas.add(handle);
    }

    canvas.render();
    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}

main();