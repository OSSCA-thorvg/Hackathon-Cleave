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
const SPARK_LIFE = 0.5;
const SPARK_COUNT = 9;
//Tuned for the carrot. Each ingredient will need its own thresholds.
const STARS = [100, 200, 300];
const GATHER_PUSH = 1.0;
//Carrot: a smooth convex cone, wide at the top, tapering to a tip.
const CARROT_VERTS = 9;
const CARROT_LEN = 380;
const CARROT_TOP = 76;
//Parallel blades that all cut on one press.
const KNIFE_SETS = [
  { scale: 1.0, count: 1, gap: 0 },
  { scale: 0.61, count: 2, gap: 34 },
  { scale: 0.44, count: 3, gap: 26 },
];

const FLING_CHANCE = 0.125;
const FLING_BOOST = 4.5;

type Pt = { x: number; y: number };

//The outline never moves. Motion lives in dx/dy and is applied by translate().
type Piece = {
  outline: Pt[];
  dx: number; dy: number;
  vx: number; vy: number;
  r: number; g: number; b: number;
  shape: any;
  live: boolean;
};

type Spark = { x: number; y: number; vx: number; vy: number; life: number; shape: any };

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

//A convex carrot silhouette: rounded shoulders, faceted flanks, blunt tip.
function carrotOutline(cx: number, cy: number): Pt[] {
  const half = CARROT_LEN / 2;

  //Width profile: full at the shoulder, easing off toward the tip.
  const widthAt = (t: number) => {
    const shoulder = Math.sin(Math.min(1, t / 0.05) * Math.PI / 2);
    const taper = Math.pow(1 - t, 0.62);
    return CARROT_TOP * taper * shoulder;
  };

  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i <= CARROT_VERTS; i++) {
    const t = i / CARROT_VERTS;
    const y = cy - half + CARROT_LEN * t;
    const w = widthAt(t);
    left.push({ x: cx - w, y });
    right.push({ x: cx + w, y });
  }

  return [...left, ...right.reverse()];
}

//Colour comes from where the piece sat inside the original carrot:
//dark orange at the skin, pale core in the middle.
function carrotColour(x: number, y: number, cx: number, cy: number) {
  const half = CARROT_LEN / 2;
  const t = Math.min(1, Math.max(0, (y - cy + half) / CARROT_LEN));
  const taper = Math.pow(1 - t, 0.62);
  const w = Math.max(6, CARROT_TOP * taper);

  //0 at the core, 1 at the skin.
  const edge = Math.min(1, Math.abs(x - cx) / w);
  const k = edge * edge;

  return {
    r: Math.round(247 - k * 25),
    g: Math.round(178 - k * 62),
    b: Math.round(112 - k * 76),
  };
}

function jitter(channel: number) {
  return clamp(channel + (Math.random() - 0.5) * 20);
}

async function main() {
  const TVG: any = await init({
    renderer: 'gl',
    locateFile: () => import.meta.env.BASE_URL + 'thorvg.wasm',
  });

  const canvas = new TVG.Canvas('#canvas', { width: WIDTH, height: HEIGHT });

  const el = document.querySelector('#canvas') as HTMLCanvasElement;
  const countEl = document.querySelector('#count') as HTMLElement;
  const timerEl = document.querySelector('#timer') as HTMLElement;
  const resultEl = document.querySelector('#result') as HTMLElement;
  const starsEl = document.querySelector('#stars') as HTMLElement;
  const finalEl = document.querySelector('#final') as HTMLElement;
  const timerWrap = document.querySelector('#timer-wrap') as HTMLElement;
  const fillEl = document.querySelector('#timer-fill') as HTMLElement;
  const knifeBtns = document.querySelectorAll('.knife');
  const introEl = document.querySelector('#intro') as HTMLElement;

  const pieces: Piece[] = [];
  const bladeShapes: any[] = [];
  const sparks: Spark[] = [];

  //A short burst along the cut, so a chop reads as a hit.
  function spawnSparks(x: number, y: number, dirX: number, dirY: number) {
    for (let i = 0; i < SPARK_COUNT; i++) {
      const spread = (Math.random() - 0.5) * 1.5;
      const sx = dirX * Math.cos(spread) - dirY * Math.sin(spread);
      const sy = dirX * Math.sin(spread) + dirY * Math.cos(spread);
      const speed = 220 + Math.random() * 380;
      const flip = Math.random() < 0.5 ? 1 : -1;

      const r = 2.5 + Math.random() * 5;
      const shape = new TVG.Shape();
      shape.appendCircle(x, y, r, r);
      shape.fill(255, 214, 150, 255);
      canvas.add(shape);

      shape.__ox = x;
      shape.__oy = y;
      sparks.push({ x, y, vx: sx * speed * flip, vy: sy * speed * flip, life: SPARK_LIFE, shape });
    }
  }

  let timeLeft = STAGE_TIME;
  let running = false;

  //Shapes are built once and kept in the scene; only translate() changes.
  function makePiece(outline: Pt[], r: number, g: number, b: number,
    vx: number, vy: number): Piece {
    const shape = new TVG.Shape();
    shape.moveTo(outline[0].x, outline[0].y);
    for (let i = 1; i < outline.length; i++) {
      shape.lineTo(outline[i].x, outline[i].y);
    }
    shape.close();
    shape.fill(r, g, b, 255);
    shape.stroke({ width: 4, color: [92, 48, 20, 255] });
    canvas.add(shape);
    return { outline, dx: 0, dy: 0, vx, vy, r, g, b, shape, live: true };
  }

  //World-space copy of a piece's outline, for hit testing.
  function worldOutline(piece: Piece): Pt[] {
    return piece.outline.map((p) => ({ x: p.x + piece.dx, y: p.y + piece.dy }));
  }

  function centroid(piece: Piece): Pt {
    let cx = 0, cy = 0;
    for (const p of piece.outline) { cx += p.x; cy += p.y; }
    return {
      x: cx / piece.outline.length + piece.dx,
      y: cy / piece.outline.length + piece.dy,
    };
  }

  function centroidOf(points: Pt[]): Pt {
    let x = 0, y = 0;
    for (const p of points) { x += p.x; y += p.y; }
    return { x: x / points.length, y: y / points.length };
  }

  function resetStage() {
    canvas.clear();
    pieces.length = 0;
    bladeShapes.length = 0;
    sparks.length = 0;

    const outline = carrotOutline(WIDTH / 2, HEIGHT / 2);
    const c = carrotColour(WIDTH / 2, HEIGHT / 2, WIDTH / 2, HEIGHT / 2);
    pieces.push(makePiece(outline, c.r, c.g, c.b, 0, 0));

    timeLeft = STAGE_TIME;
    running = false;
    introEl.classList.remove('gone');
    resultEl.classList.remove('show');
    timerWrap.classList.remove('low');
    fillEl.style.width = '100%';
    setKnife(0);
    countEl.textContent = '1';

    //Leaves sit on the carrot for a moment, then get trimmed away.
    const leaves = document.querySelector('#leaves') as HTMLElement;
    leaves.classList.remove('gone');
  }

  function endStage() {
    running = false;
    const n = pieces.length;
    let earned = 0;
    for (const t of STARS) if (n >= t) earned++;
    starsEl.textContent = '★'.repeat(earned) + '☆'.repeat(3 - earned);
    finalEl.textContent = String(n);
    resultEl.classList.add('show');
    console.log('final: ' + n);
  }

  (document.querySelector('#again') as HTMLElement)
    .addEventListener('click', resetStage);

  //Play only begins once the cook is ready, so the timer never runs on an idle screen.
  function startStage() {
    introEl.classList.add('gone');
    running = true;
    const leaves = document.querySelector('#leaves') as HTMLElement;
    setTimeout(() => leaves.classList.add('gone'), 700);
  }

  (document.querySelector('#start') as HTMLElement)
    .addEventListener('click', startStage);

  let cursor: Pt = { x: WIDTH / 2, y: HEIGHT / 2 };
  let knifeAngle = 0;
  let knifeSet = 0;

  function setKnife(n: number) {
    knifeSet = n;
    knifeBtns.forEach((b, i) => b.classList.toggle('active', i === n));
  }

  knifeBtns.forEach((b) => {
    b.addEventListener('click', () => setKnife(Number((b as HTMLElement).dataset.set)));
  });

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
    if (e.code === 'Digit1') setKnife(0);
    if (e.code === 'Digit2') setKnife(1);
    if (e.code === 'Digit3') setKnife(2);
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
    if (Math.hypot(mx, my) < 0.5) return;

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
      const c = centroid(piece);
      const rx = c.x - to.x;
      const ry = c.y - to.y;

      //Distance along the blade, and perpendicular to it.
      const t = rx * dx + ry * dy;
      const s = rx * nx + ry * ny;
      if (Math.abs(t) > half) continue;
      if (Math.abs(s) > reach) continue;

      //Push only what is in front of the sweep, not behind it.
      if (s * shove > 0) continue;

      const delta = shove * GATHER_PUSH;
      piece.dx += nx * delta;
      piece.dy += ny * delta;
      piece.shape.translate(piece.dx, piece.dy);
      piece.vx = 0;
      piece.vy = 0;
    }
  }

  function chop() {
    if (!running) return;
    const set = KNIFE_SETS[knifeSet];
    const dirX = Math.cos(knifeAngle);
    const dirY = Math.sin(knifeAngle);
    const nx = -dirY;
    const ny = dirX;

    //The handle end is decoration, so only the sharp part counts.
    const full = KNIFE_LEN * set.scale;
    const half = full / 2;
    const edgeBack = -half + full * HANDLE_RATIO;

    for (const [a, b] of bladeLines()) {
      const origin = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const born: Piece[] = [];
      let cutAny = false;

      for (const piece of pieces) {
        const world = worldOutline(piece);
        if (!bladeCuts(world, origin, dirX, dirY, edgeBack, half)) continue;

        const left = clipHalf(world, a, b, true);
        const right = clipHalf(world, a, b, false);

        //The line missed, or would only shave a sliver off.
        if (left.length < 3 || right.length < 3 ||
          area(left) < MIN_AREA || area(right) < MIN_AREA) continue;

        //Every so often a piece goes flying, so there is a reason to gather.
        const fling = Math.random() < FLING_CHANCE ? FLING_BOOST : 1;
        const push = (3 + Math.random() * 4) * DRIFT_SPEED * fling;

        //Each piece keeps the colour of wherever it came from.
        const lc = centroidOf(left);
        const rc = centroidOf(right);
        const lcol = carrotColour(lc.x, lc.y, WIDTH / 2, HEIGHT / 2);
        const rcol = carrotColour(rc.x, rc.y, WIDTH / 2, HEIGHT / 2);

        born.push(makePiece(left, jitter(lcol.r), jitter(lcol.g), jitter(lcol.b),
          nx * push, ny * push));
        born.push(makePiece(right, jitter(rcol.r), jitter(rcol.g), jitter(rcol.b),
          -nx * push, -ny * push));

        //Burst where the blade actually crossed, not at the piece's centre.
        const cutMid = {
          x: (lc.x + rc.x) / 2,
          y: (lc.y + rc.y) / 2,
        };
        spawnSparks(cutMid.x, cutMid.y, dirX, dirY);
        piece.live = false;
        cutAny = true;
      }

      if (cutAny) {
        for (let i = pieces.length - 1; i >= 0; i--) {
          if (!pieces[i].live) {
            pieces[i].shape.opacity(0);
            pieces.splice(i, 1);
          }
        }
        pieces.push(...born);
      }
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
      fillEl.style.width = (timeLeft / STAGE_TIME * 100) + '%';
      if (timeLeft <= 5) timerWrap.classList.add('low');
    }

    if (rotating) knifeAngle += ROT_SPEED * dt;

    //Only moving pieces touch the scene; the rest cost nothing.
    for (const piece of pieces) {
      if (piece.vx === 0 && piece.vy === 0) continue;

      if (Math.abs(piece.vx) < DRIFT_STOP && Math.abs(piece.vy) < DRIFT_STOP) {
        piece.vx = 0;
        piece.vy = 0;
        continue;
      }

      piece.dx += piece.vx * dt;
      piece.dy += piece.vy * dt;
      piece.vx *= DAMPING;
      piece.vy *= DAMPING;

      //Pieces bounce off the edge of the board instead of escaping.
      const c = centroid(piece);
      const M = 40;
      if (c.x < M && piece.vx < 0) piece.vx *= -0.4;
      if (c.x > WIDTH - M && piece.vx > 0) piece.vx *= -0.4;
      if (c.y < M && piece.vy < 0) piece.vy *= -0.4;
      if (c.y > HEIGHT - M && piece.vy > 0) piece.vy *= -0.4;

      piece.shape.translate(piece.dx, piece.dy);
    }

    //Sparks fade out and leave the scene.
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life -= dt;
      if (s.life <= 0) {
        s.shape.opacity(0);
        sparks.splice(i, 1);
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 0.93;
      s.vy *= 0.93;
      s.shape.translate(s.x - s.shape.__ox, s.y - s.shape.__oy);
      s.shape.opacity(Math.round(255 * (s.life / SPARK_LIFE)));
    }

    //The blade is rebuilt each frame; that is two shapes, not eight hundred.
    for (const s of bladeShapes) s.opacity(0);
    bladeShapes.length = 0;

    for (const [a, b] of bladeLines()) {
      const blade = new TVG.Shape();
      blade.moveTo(a.x, a.y);
      blade.lineTo(b.x, b.y);
      blade.stroke({ width: 7, color: [225, 228, 235, 235] });
      canvas.add(blade);
      bladeShapes.push(blade);

      const hx = a.x + (b.x - a.x) * HANDLE_RATIO;
      const hy = a.y + (b.y - a.y) * HANDLE_RATIO;
      const handle = new TVG.Shape();
      handle.moveTo(a.x, a.y);
      handle.lineTo(hx, hy);
      handle.stroke({ width: 13, color: [92, 58, 38, 255] });
      canvas.add(handle);
      bladeShapes.push(handle);
    }

    canvas.update();
    canvas.render();
    requestAnimationFrame(animate);
  }

  resetStage();
  requestAnimationFrame(animate);
}

main();