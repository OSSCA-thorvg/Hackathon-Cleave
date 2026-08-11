import { init } from '@thorvg/webcanvas';

const WIDTH = 900;
const HEIGHT = 560;

//A piece thinner than this would be invisible, so the cut is refused.
const MIN_AREA = 60;
const DAMPING = 0.97;
const DRIFT_SPEED = 12;
const DRIFT_STOP = 0.8;

//Now and then a piece is flung far, which is what makes gathering worth doing.
const FLING_CHANCE = 0.125;
const FLING_BOOST = 4.5;

const KNIFE_LEN = 300;
const ROT_SPEED = 2.4;
const CUT_COVERAGE = 0.66;
const HANDLE_RATIO = 0.16;
const GATHER_PUSH = 1.0;

const SPARK_LIFE = 0.5;
const SPARK_COUNT = 9;
const SPARK_DAMPING = 0.93;

//Parallel blades that all cut on one press.
const KNIFE_SETS = [
  { scale: 1.0, count: 1, gap: 0 },
  { scale: 0.61, count: 2, gap: 34 },
  { scale: 0.44, count: 3, gap: 26 },
];

type Pt = { x: number; y: number };
type Rgb = { r: number; g: number; b: number };

//An outline never moves. Motion lives in dx/dy and is applied by translate().
type Piece = {
  outline: Pt[];
  dx: number; dy: number;
  vx: number; vy: number;
  r: number; g: number; b: number;
  shape: any;
  live: boolean;
};

type Spark = {
  dx: number; dy: number;
  vx: number; vy: number;
  life: number;
  shape: any;
};

type LayerName = 'gameplay' | 'effects' | 'knife';

//A stage is one ingredient: its shape, its colouring, and how long you get.
type Stage = {
  name: string;
  time: number;
  stars: [number, number, number];
  decor: 'leaves' | 'calyx' | null;
  build: (cx: number, cy: number) => Pt[][];
  colour: (x: number, y: number, cx: number, cy: number) => Rgb;
};

// ---------------------------------------------------------------- geometry

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

function centroidOf(points: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of points) { x += p.x; y += p.y; }
  return { x: x / points.length, y: y / points.length };
}

//Keeps only the half-plane on one side of the line ab. (Sutherland-Hodgman)
//Cutting a convex polygon with a line always yields convex pieces,
//so the assumption holds under repeated slicing.
function clipHalf(points: Pt[], a: Pt, b: Pt, positive: boolean) {
  const out: Pt[] = [];
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    const next = points[(i + 1) % points.length];
    let dCur = side(a, b, cur);
    let dNext = side(a, b, next);
    if (!positive) { dCur = -dCur; dNext = -dNext; }

    if (dCur >= 0) out.push(cur);

    //This edge straddles the line, so interpolate where it crosses.
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

//A cut lands when the sharp part of the blade covers enough of the chord it
//would carve. Smaller pieces have shorter chords, so slicing gets harder.
function bladeCuts(outline: Pt[], origin: Pt, dx: number, dy: number,
  lo0: number, hi0: number) {
  const a = { x: origin.x - dx * 1000, y: origin.y - dy * 1000 };
  const b = { x: origin.x + dx * 1000, y: origin.y + dy * 1000 };

  //Where the blade's line enters and leaves the piece.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < outline.length; i++) {
    const cur = outline[i];
    const next = outline[(i + 1) % outline.length];
    const dCur = side(a, b, cur);
    const dNext = side(a, b, next);
    if ((dCur > 0) === (dNext > 0)) continue;

    const t = dCur / (dCur - dNext);
    const s = along({
      x: cur.x + t * (next.x - cur.x),
      y: cur.y + t * (next.y - cur.y),
    }, origin, dx, dy);

    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }

  //The line missed the piece entirely.
  if (hi <= lo) return false;

  const covered = Math.min(hi, hi0) - Math.max(lo, lo0);
  if (covered <= 0) return false;

  return covered >= (hi - lo) * CUT_COVERAGE;
}

// ---------------------------------------------------------------- colouring

function clamp(v: number) {
  return Math.max(45, Math.min(245, Math.round(v)));
}

function jitter(channel: number) {
  return clamp(channel + (Math.random() - 0.5) * 20);
}

// ---------------------------------------------------------------- ingredients

const CARROT_VERTS = 9;
const CARROT_LEN = 380;
const CARROT_TOP = 76;

//A convex carrot: faceted flanks narrowing to a blunt tip.
function carrotOutline(cx: number, cy: number): Pt[][] {
  const half = CARROT_LEN / 2;

  const widthAt = (t: number) => {
    const shoulder = Math.sin(Math.min(1, t / 0.05) * Math.PI / 2);
    return CARROT_TOP * Math.pow(1 - t, 0.62) * shoulder;
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

  return [[...left, ...right.reverse()]];
}

//Colour follows where a piece sat in the whole carrot: dark skin, pale core.
function carrotColour(x: number, y: number, cx: number, cy: number): Rgb {
  const half = CARROT_LEN / 2;
  const t = Math.min(1, Math.max(0, (y - cy + half) / CARROT_LEN));
  const w = Math.max(6, CARROT_TOP * Math.pow(1 - t, 0.62));

  const edge = Math.min(1, Math.abs(x - cx) / w);
  const k = edge * edge;

  return {
    r: Math.round(247 - k * 25),
    g: Math.round(178 - k * 62),
    b: Math.round(112 - k * 76),
  };
}

const TOMATO_R = 165;

//A plump convex disc, slightly squashed.
function tomatoOutline(cx: number, cy: number): Pt[][] {
  const out: Pt[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    out.push({
      x: cx + TOMATO_R * Math.cos(a),
      y: cy + TOMATO_R * Math.sin(a) * 0.92,
    });
  }
  return [out];
}

function tomatoColour(x: number, y: number, cx: number, cy: number): Rgb {
  const d = Math.min(1, Math.hypot(x - cx, y - cy) / TOMATO_R);
  const k = d * d;
  return {
    r: Math.round(198 - k * 44),
    g: Math.round(52 - k * 26),
    b: Math.round(42 - k * 20),
  };
}

const ONION_SPAN = 240;

//Three separate stalks laid across the board, so play opens with three pieces.
function onionOutline(cx: number, cy: number): Pt[][] {
  const stalks = [
    { ox: -10, oy: -66, ang: 0.05, len: 430, w: 32 },
    { ox: 20, oy: 6, ang: -0.09, len: 470, w: 36 },
    { ox: -30, oy: 80, ang: 0.13, len: 400, w: 30 },
  ];

  return stalks.map((s) => {
    const dx = Math.cos(s.ang);
    const dy = Math.sin(s.ang);
    const nx = -dy;
    const ny = dx;
    const h = s.len / 2;
    const x = cx + s.ox;
    const y = cy + s.oy;

    return [
      { x: x - dx * h + nx * s.w, y: y - dy * h + ny * s.w },
      { x: x + dx * h + nx * s.w, y: y + dy * h + ny * s.w },
      { x: x + dx * h - nx * s.w, y: y + dy * h - ny * s.w },
      { x: x - dx * h - nx * s.w, y: y - dy * h - ny * s.w },
    ];
  });
}

//White at the root end, green toward the leaves.
function onionColour(x: number, _y: number, cx: number, _cy: number): Rgb {
  const t = Math.min(1, Math.max(0, (x - cx + ONION_SPAN) / (ONION_SPAN * 2)));
  return {
    r: Math.round(232 - t * 110),
    g: Math.round(240 - t * 60),
    b: Math.round(214 - t * 130),
  };
}

const STAGES: Stage[] = [
  {
    name: '당근', time: 30, stars: [100, 200, 300],
    decor: 'leaves', build: carrotOutline, colour: carrotColour,
  },
  {
    name: '토마토', time: 25, stars: [200, 500, 800],
    decor: 'calyx', build: tomatoOutline, colour: tomatoColour,
  },
  {
    name: '파', time: 20, stars: [200, 350, 500],
    decor: null, build: onionOutline, colour: onionColour,
  },
];

// ---------------------------------------------------------------- game

async function main() {
  const TVG: any = await init({
    renderer: 'gl',
    locateFile: () => import.meta.env.BASE_URL + 'thorvg.wasm',
  });

  const canvas = new TVG.Canvas('#canvas', { width: WIDTH, height: HEIGHT });
  const el = document.querySelector('#canvas') as HTMLCanvasElement;

  const countEl = document.querySelector('#count') as HTMLElement;
  const goalEl = document.querySelector('#goal') as HTMLElement;
  const timerEl = document.querySelector('#timer') as HTMLElement;
  const timerWrap = document.querySelector('#timer-wrap') as HTMLElement;
  const fillEl = document.querySelector('#timer-fill') as HTMLElement;
  const stageNameEl = document.querySelector('#stage-name') as HTMLElement;
  const knifeBtns = document.querySelectorAll('.knife');

  const introEl = document.querySelector('#intro') as HTMLElement;
  const selectEl = document.querySelector('#select') as HTMLElement;
  const resultEl = document.querySelector('#result') as HTMLElement;
  const starsEl = document.querySelector('#stars') as HTMLElement;
  const finalEl = document.querySelector('#final') as HTMLElement;
  const finalGoalEl = document.querySelector('#final-goal') as HTMLElement;
  const countdownEl = document.querySelector('#countdown') as HTMLElement;
  const countTextEl = document.querySelector('#count-text') as HTMLElement;

  const leavesEl = document.querySelector('#leaves') as HTMLElement;
  const calyxEl = document.querySelector('#calyx') as HTMLElement;

  const pieces: Piece[] = [];
  const sparks: Spark[] = [];
  const bladeShapes: any[] = [];
  const layerShapes: Record<LayerName, any[]> = {
    gameplay: [],
    effects: [],
    knife: [],
  }

  let stage = STAGES[0];
  let timeLeft = stage.time;
  let running = false;

  let cursor: Pt = { x: WIDTH / 2, y: HEIGHT / 2 };
  let knifeAngle = 0;
  let knifeSet = 0;
  let rotating = false;
  let sweeping = false;

  // ---- scene ----

  function addToLayer(layer: LayerName, shape: any) {
    canvas.add(shape);
    layerShapes[layer].push(shape);
    return shape;
  }

  function hideLayer(layer: LayerName) {
    for (const shape of layerShapes[layer]) shape.opacity(0);
    layerShapes[layer].length = 0;
  }

  function resetSceneLayers() {
    hideLayer('gameplay');
    hideLayer('effects');
    hideLayer('knife');
  }

  //Shapes are built once and kept in the scene; only translate() changes.
  function makePiece(outline: Pt[], colour: Rgb, vx: number, vy: number): Piece {
    const shape = new TVG.Shape();
    shape.moveTo(outline[0].x, outline[0].y);
    for (let i = 1; i < outline.length; i++) {
      shape.lineTo(outline[i].x, outline[i].y);
    }
    shape.close();
    shape.fill(colour.r, colour.g, colour.b, 255);
    shape.stroke({ width: 4, color: [92, 48, 20, 255] });
    addToLayer('gameplay', shape);

    return {
      outline, dx: 0, dy: 0, vx, vy,
      r: colour.r, g: colour.g, b: colour.b,
      shape, live: true,
    };
  }

  //World-space copy of a piece's outline, for hit testing.
  function worldOutline(piece: Piece): Pt[] {
    return piece.outline.map((p) => ({ x: p.x + piece.dx, y: p.y + piece.dy }));
  }

  function pieceCentre(piece: Piece): Pt {
    const c = centroidOf(piece.outline);
    return { x: c.x + piece.dx, y: c.y + piece.dy };
  }

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
      addToLayer('effects', shape);

      sparks.push({
        dx: 0, dy: 0,
        vx: sx * speed * flip,
        vy: sy * speed * flip,
        life: SPARK_LIFE,
        shape,
      });
    }
  }

  // ---- stage flow ----

  function showCount() {
    const n = pieces.length;
    countEl.textContent = String(n);
    const next = stage.stars.find((t) => n < t);
    goalEl.textContent = next ? '★ ' + next : '★★★';
  }

  function resetStage() {
    canvas.clear();
    pieces.length = 0;
    sparks.length = 0;
    bladeShapes.length = 0;

    for (const outline of stage.build(WIDTH / 2, HEIGHT / 2)) {
      const c = centroidOf(outline);
      pieces.push(makePiece(outline, stage.colour(c.x, c.y, WIDTH / 2, HEIGHT / 2), 0, 0));
    }

    timeLeft = stage.time;
    running = false;
    stageNameEl.textContent = stage.name;
    timerEl.textContent = String(stage.time);
    timerWrap.classList.remove('low');
    fillEl.style.width = '100%';
    resultEl.classList.add('gone');
    setKnife(0);
    showCount();

    //Only the current ingredient's garnish sits on the board.
    leavesEl.style.display = stage.decor === 'leaves' ? 'block' : 'none';
    calyxEl.style.display = stage.decor === 'calyx' ? 'block' : 'none';
    leavesEl.classList.remove('gone');
    calyxEl.classList.remove('gone');
  }

  //Three beats before the timer starts, so the cook can settle in.
  function runCountdown() {
    const beats = ['3', '2', '1', 'GO!'];
    let i = 0;
    countdownEl.classList.add('show');

    const tick = () => {
      countTextEl.textContent = beats[i];
      countTextEl.classList.remove('beat');
      void countTextEl.offsetWidth;   //restarts the CSS animation
      countTextEl.classList.add('beat');

      i++;
      if (i < beats.length) {
        setTimeout(tick, 700);
        return;
      }

      setTimeout(() => {
        countdownEl.classList.remove('show');
        leavesEl.classList.add('gone');
        calyxEl.classList.add('gone');
        running = true;
      }, 700);
    };

    tick();
  }

  function loadStage(i: number) {
    stage = STAGES[i];
    selectEl.classList.add('gone');
    resetStage();
    runCountdown();
  }

  //The rules only need showing once; after that we go straight to the board.
  function showSelect() {
    introEl.classList.add('gone');
    resultEl.classList.add('gone');
    selectEl.classList.remove('gone');
  }

  function replay() {
    resetStage();
    runCountdown();
  }

  function endStage() {
    running = false;
    const n = pieces.length;

    let earned = 0;
    for (const t of stage.stars) if (n >= t) earned++;

    starsEl.textContent = '★'.repeat(earned) + '☆'.repeat(3 - earned);
    finalEl.textContent = String(n);
    finalGoalEl.textContent = stage.stars.map((t) => '★' + t).join('  ');
    resultEl.classList.remove('gone');
  }

  (document.querySelector('#start') as HTMLElement)
    .addEventListener('click', showSelect);
  (document.querySelector('#again') as HTMLElement)
    .addEventListener('click', replay);
  (document.querySelector('#to-select') as HTMLElement)
    .addEventListener('click', showSelect);

  document.querySelectorAll('.stage-card[data-stage]').forEach((card) => {
    card.addEventListener('click', () =>
      loadStage(Number((card as HTMLElement).dataset.stage)));
  });

  // ---- input ----

  function setKnife(n: number) {
    knifeSet = n;
    knifeBtns.forEach((b, i) => b.classList.toggle('active', i === n));
  }

  knifeBtns.forEach((b) => {
    b.addEventListener('click', () =>
      setKnife(Number((b as HTMLElement).dataset.set)));
  });

  //Map a pointer event to canvas coordinates.
  function position(e: PointerEvent): Pt {
    const rect = el.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width * WIDTH,
      y: (e.clientY - rect.top) / rect.height * HEIGHT,
    };
  }

  //Otherwise right-click opens the browser menu instead of turning the blade.
  el.addEventListener('contextmenu', (e) => e.preventDefault());

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

  el.addEventListener('pointermove', (e) => {
    const next = position(e);

    //Reading the button state here keeps the left click working even while
    //the right button is held down for rotation.
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

  el.addEventListener('pointerup', (e) => {
    if (e.button === 2) rotating = false;
    if (e.button === 0) sweeping = false;
  });

  //Keyboard backup for laptops without a mouse.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); rotating = true; }
    if (e.code === 'Digit1') setKnife(0);
    if (e.code === 'Digit2') setKnife(1);
    if (e.code === 'Digit3') setKnife(2);
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') rotating = false;
  });

  // ---- knife ----

  //Each blade of the current set, as [tail, tip] pairs.
  function bladeLines(): [Pt, Pt][] {
    const set = KNIFE_SETS[knifeSet];
    const dx = Math.cos(knifeAngle);
    const dy = Math.sin(knifeAngle);
    const nx = -dy;
    const ny = dx;
    const half = KNIFE_LEN * set.scale / 2;
    const spread = (set.count - 1) / 2;

    const lines: [Pt, Pt][] = [];
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
      const c = pieceCentre(piece);
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

      for (const piece of pieces) {
        const world = worldOutline(piece);
        if (!bladeCuts(world, origin, dirX, dirY, edgeBack, half)) continue;

        const left = clipHalf(world, a, b, true);
        const right = clipHalf(world, a, b, false);

        //The line missed, or would only shave a sliver off.
        if (left.length < 3 || right.length < 3 ||
          area(left) < MIN_AREA || area(right) < MIN_AREA) continue;

        const fling = Math.random() < FLING_CHANCE ? FLING_BOOST : 1;
        const push = (3 + Math.random() * 4) * DRIFT_SPEED * fling;

        //Each new piece takes the colour of wherever it came from.
        const lc = centroidOf(left);
        const rc = centroidOf(right);
        const lcol = stage.colour(lc.x, lc.y, WIDTH / 2, HEIGHT / 2);
        const rcol = stage.colour(rc.x, rc.y, WIDTH / 2, HEIGHT / 2);

        born.push(makePiece(left, {
          r: jitter(lcol.r), g: jitter(lcol.g), b: jitter(lcol.b),
        }, nx * push, ny * push));

        born.push(makePiece(right, {
          r: jitter(rcol.r), g: jitter(rcol.g), b: jitter(rcol.b),
        }, -nx * push, -ny * push));

        //Burst where the blade crossed, not at the piece's centre.
        spawnSparks((lc.x + rc.x) / 2, (lc.y + rc.y) / 2, dirX, dirY);
        piece.live = false;
      }

      if (born.length === 0) continue;

      for (let i = pieces.length - 1; i >= 0; i--) {
        if (pieces[i].live) continue;
        pieces[i].shape.opacity(0);
        pieces.splice(i, 1);
      }
      pieces.push(...born);
    }

    showCount();
  }

  // ---- loop ----

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
      fillEl.style.width = (timeLeft / stage.time * 100) + '%';
      if (timeLeft <= 5) timerWrap.classList.add('low');
    }

    if (rotating) knifeAngle += ROT_SPEED * dt;

    //Only moving pieces touch the scene; a piece at rest costs nothing.
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

      //Pieces bounce off the edge of the board instead of escaping it.
      const c = pieceCentre(piece);
      const margin = 40;
      if (c.x < margin && piece.vx < 0) piece.vx *= -0.4;
      if (c.x > WIDTH - margin && piece.vx > 0) piece.vx *= -0.4;
      if (c.y < margin && piece.vy < 0) piece.vy *= -0.4;
      if (c.y > HEIGHT - margin && piece.vy > 0) piece.vy *= -0.4;

      piece.shape.translate(piece.dx, piece.dy);
    }

    //Sparks drift outward, fade, and leave the scene.
    for (let i = sparks.length - 1; i >= 0; i--) {
      const spark = sparks[i];
      spark.life -= dt;
      if (spark.life <= 0) {
        spark.shape.opacity(0);
        sparks.splice(i, 1);
        continue;
      }

      spark.dx += spark.vx * dt;
      spark.dy += spark.vy * dt;
      spark.vx *= SPARK_DAMPING;
      spark.vy *= SPARK_DAMPING;
      spark.shape.translate(spark.dx, spark.dy);
      spark.shape.opacity(Math.round(255 * (spark.life / SPARK_LIFE)));
    }

    //The blade follows the cursor every frame, but that is a handful of
    //shapes rather than the hundreds sitting on the board.
    for (const shape of bladeShapes) shape.opacity(0);
    bladeShapes.length = 0;

    for (const [a, b] of bladeLines()) {
      const blade = new TVG.Shape();
      blade.moveTo(a.x, a.y);
      blade.lineTo(b.x, b.y);
      blade.stroke({ width: 7, color: [225, 228, 235, 235] });
      addToLayer('knife', blade);
      bladeShapes.push(blade);

      const hx = a.x + (b.x - a.x) * HANDLE_RATIO;
      const hy = a.y + (b.y - a.y) * HANDLE_RATIO;
      const handle = new TVG.Shape();
      handle.moveTo(a.x, a.y);
      handle.lineTo(hx, hy);
      handle.stroke({ width: 13, color: [92, 58, 38, 255] });
      addToLayer('knife', handle);
      bladeShapes.push(handle);
    }

    canvas.update();
    canvas.render();
    requestAnimationFrame(animate);
  }

  resetSceneLayers();
  canvas.clear();
  resetStage();
  requestAnimationFrame(animate);
}

main();