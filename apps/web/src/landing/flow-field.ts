interface LinePoint { x: number; y: number; on: boolean }
interface Line { pts: LinePoint[]; key: number; t: number }
interface Obstacle { cx: number; cy: number; hx: number; hy: number; r: number }

// Ported from aiur.team: diagonal lines are sampled on a canvas and clipped
// around each `.keepout` element with rounded-rectangle distance fields.
export function createFlowField(): { redraw: () => void } {
  const canvas = document.querySelector<HTMLCanvasElement>('#field');
  const hero = document.querySelector<HTMLElement>('.stage');
  const context = canvas?.getContext('2d') ?? null;
  if (!canvas || !hero || !context) return { redraw: () => undefined };
  const surface = canvas;
  const stage = hero;
  const ctx = context;

  const angle = -118 * (Math.PI / 180);
  const direction = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -direction.y, y: direction.x };
  const spacing = 23;
  const step = 7;
  const gap = 9;
  const fade = 260;
  const topbar = 50;
  let width = 0;
  let height = 0;
  let lines: Line[] = [];
  let obstacles: Obstacle[] = [];
  let progress = 1;

  function roundRectDistance(x: number, y: number, obstacle: Obstacle): number {
    const qx = Math.abs(x - obstacle.cx) - (obstacle.hx - obstacle.r);
    const qy = Math.abs(y - obstacle.cy) - (obstacle.hy - obstacle.r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - obstacle.r;
  }

  function buildObstacles(): void {
    const canvasRect = surface.getBoundingClientRect();
    obstacles = [...document.querySelectorAll<HTMLElement>('.keepout')].flatMap(element => {
      const rect = element.getBoundingClientRect();
      if (!rect.width) return [];
      const isLogo = element.classList.contains('logo');
      const halfWidth = rect.width / 2 + (isLogo ? 3 : 9);
      const halfHeight = rect.height / 2 + (isLogo ? 1 : 6);
      return [{
        cx: rect.left - canvasRect.left + rect.width / 2,
        cy: rect.top - canvasRect.top + rect.height / 2,
        hx: halfWidth,
        hy: halfHeight,
        r: Math.min(halfWidth, halfHeight) * (isLogo ? 0.95 : 0.55),
      }];
    });
  }

  function buildLines(): void {
    lines = [];
    if (!width || !height) return;
    const centerX = width / 2;
    const centerY = height / 2;
    const diagonal = Math.hypot(width, height);
    const half = diagonal / 2 + spacing;
    const count = Math.ceil(diagonal / spacing) + 2;
    for (let index = -count; index <= count; index += 1) {
      const offset = index * spacing;
      const anchorX = centerX + normal.x * offset;
      const anchorY = centerY + normal.y * offset;
      const points: LinePoint[] = [];
      for (let distance = -half; distance <= half; distance += step) {
        const point = { x: anchorX + direction.x * distance, y: anchorY + direction.y * distance, on: true };
        point.on = !obstacles.some(obstacle => roundRectDistance(point.x, point.y, obstacle) < gap);
        points.push(point);
      }
      lines.push({ pts: points, key: anchorX + anchorY, t: 0 });
    }
    const keys = lines.map(line => line.key);
    const minimum = Math.min(...keys);
    const span = Math.max(...keys) - minimum || 1;
    for (const line of lines) line.t = (line.key - minimum) / span;
  }

  function draw(): void {
    if (!width) return;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--line').trim();
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    for (const line of lines) {
      const local = Math.max(0, Math.min(1, (progress - line.t * 0.32) / 0.68));
      if (!local) continue;
      ctx.globalAlpha = local;
      ctx.beginPath();
      let pen = false;
      for (const point of line.pts) {
        if (!point.on) { pen = false; continue; }
        if (pen) ctx.lineTo(point.x, point.y);
        else { ctx.moveTo(point.x, point.y); pen = true; }
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function resize(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = stage.clientWidth;
    height = stage.clientHeight + topbar + fade;
    surface.width = width * ratio;
    surface.height = height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    buildObstacles();
    buildLines();
    draw();
  }

  function start(): void {
    resize();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    progress = 0;
    let started: number | undefined;
    const frame = (timestamp: number) => {
      started ??= timestamp;
      const elapsed = (timestamp - started) / 1500;
      progress = elapsed >= 1 ? 1 : 1 - (1 - elapsed) ** 3;
      draw();
      if (elapsed < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  void document.fonts?.ready.then(resize);
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resize, 120);
  });
  window.addEventListener('load', start);
  if (document.readyState === 'complete') start();
  return { redraw: draw };
}
