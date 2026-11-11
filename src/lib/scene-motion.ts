/** A response in seconds keeps camera and pose easing consistent across frame rates. */
export function motionBlend(response: number, deltaSeconds: number): number {
  return -Math.expm1(-Math.max(0, response) * Math.max(0, deltaSeconds));
}

/** Preserve the existing pose tuning, which was authored around 30 fps. */
export function frameBlend(blend: number, deltaSeconds: number): number {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, blend)), Math.max(0, deltaSeconds) * 30);
}

export function zoomRadius(radius: number, ratio: number): number {
  return Math.min(32, Math.max(7, radius * ratio));
}

export function nearestAngle(target: number, current: number): number {
  return current + Math.atan2(Math.sin(target - current), Math.cos(target - current));
}

type Point = { x: number; y: number; startX: number; startY: number; tap: boolean };

/** Pointer capture is owned by the scene; unrelated UI releases cannot activate a bot. */
export class SceneGesture {
  private points = new Map<number, Point>();

  get active(): boolean { return this.points.size > 0; }

  start(id: number, x: number, y: number): void {
    if (this.points.size >= 2) return;
    const tap = this.points.size === 0;
    this.points.forEach((point) => { point.tap = false; });
    this.points.set(id, { x, y, startX: x, startY: y, tap });
  }

  move(id: number, x: number, y: number): { x: number; y: number; zoom: number } {
    const point = this.points.get(id);
    if (!point) return { x: 0, y: 0, zoom: 1 };
    const other = Array.from(this.points.entries()).find(([otherId]) => otherId !== id)?.[1];
    const oldDistance = other ? Math.hypot(point.x - other.x, point.y - other.y) : 0;
    const dx = x - point.x;
    const dy = y - point.y;
    point.x = x;
    point.y = y;
    if (Math.hypot(x - point.startX, y - point.startY) >= 6) point.tap = false;
    if (other) {
      const distance = Math.hypot(x - other.x, y - other.y);
      return { x: 0, y: 0, zoom: distance > 2 && oldDistance > 2 ? oldDistance / distance : 1 };
    }
    return { x: dx, y: dy, zoom: 1 };
  }

  end(id: number, x: number, y: number): boolean {
    const point = this.points.get(id);
    if (!point) return false;
    this.points.delete(id);
    return point.tap && Math.hypot(x - point.startX, y - point.startY) < 6;
  }

  cancel(id?: number): void {
    if (id === undefined) this.points.clear();
    else this.points.delete(id);
  }
}
