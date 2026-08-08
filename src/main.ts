import { init } from '@thorvg/webcanvas';

const WIDTH = 900;
const HEIGHT = 480;

const MIN_AREA = 60;
const DAMPING = 0.97;
const DRIFT_SPEED = 12;
const DRIFT_STOP = 0.8;

type Pt = { x: number; y: number };
type Piece = { outline: Pt[]; r: number; g: number; b: number; vx: number; vy: number };

function side(a: Pt, b: Pt, p: Pt) {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

function area(points: Pt[]) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return Math.abs(sum) * 0.5;
}

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

  let dragBegin: Pt | null = null;
  let dragEnd: Pt | null = null;

  const el = document.querySelector('#canvas') as HTMLCanvasElement;

  function position(e: PointerEvent): Pt {
    const rect = el.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width * WIDTH,
      y: (e.clientY - rect.top) / rect.height * HEIGHT,
    };
  }

  el.addEventListener('pointerdown', (e) => {
    dragBegin = position(e);
    dragEnd = dragBegin;
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', (e) => {
    if (dragBegin) dragEnd = position(e);
  });

  el.addEventListener('pointerup', (e) => {
    if (!dragBegin) return;

    const a = dragBegin;
    const b = position(e);
    dragBegin = null;
    dragEnd = null;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 10) return;

    const nx = -dy / length;
    const ny = dx / length;

    const result: Piece[] = [];
    for (const piece of pieces) {
      const left = clipHalf(piece.outline, a, b, true);
      const right = clipHalf(piece.outline, a, b, false);

      if (left.length < 3 || right.length < 3 ||
        area(left) < MIN_AREA || area(right) < MIN_AREA) {
        result.push(piece);
        continue;
      }

      const push = (3 + Math.random() * 4) * DRIFT_SPEED;
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
    console.log('pieces: ' + pieces.length);
  });

  let lastTime = 0;

  function animate(time: number) {
    const dt = lastTime === 0 ? 0.016 : Math.min((time - lastTime) / 1000, 0.1);
    lastTime = time;

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
    }

    canvas.clear();

    for (const piece of pieces) {
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

    if (dragBegin && dragEnd) {
      const guide = new TVG.Shape();
      guide.moveTo(dragBegin.x, dragBegin.y);
      guide.lineTo(dragEnd.x, dragEnd.y);
      guide.stroke({ width: 2, color: [255, 90, 90, 200] });
      canvas.add(guide);
    }

    canvas.render();
    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}

main();