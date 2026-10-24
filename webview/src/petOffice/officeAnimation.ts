export interface OfficeAnimationMetrics {
  frames: number;
  fps: number;
  drawMs: number;
  running: boolean;
}

interface AnimationScheduler {
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
}

/** One clock for the whole scene; hidden surfaces hold no scheduled RAF. */
export class OfficeAnimationClock {
  private frameId: number | null = null;
  private active = false;
  private lastDraw = -Infinity;
  private sampleStart = 0;
  private sampleFrames = 0;
  private metrics: OfficeAnimationMetrics = { frames: 0, fps: 0, drawMs: 0, running: false };
  private readonly draw: (time: number) => void;
  private readonly scheduler: AnimationScheduler;
  private readonly onMetrics?: (metrics: OfficeAnimationMetrics) => void;

  constructor(
    draw: (time: number) => void,
    scheduler: AnimationScheduler = {
      request: callback => requestAnimationFrame(callback),
      cancel: id => cancelAnimationFrame(id),
    },
    onMetrics?: (metrics: OfficeAnimationMetrics) => void,
  ) {
    this.draw = draw;
    this.scheduler = scheduler;
    this.onMetrics = onMetrics;
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.metrics.running = active;
    this.lastDraw = -Infinity;
    this.sampleStart = 0;
    this.sampleFrames = 0;
    if (active) this.frameId = this.scheduler.request(this.tick);
    else if (this.frameId !== null) {
      this.scheduler.cancel(this.frameId);
      this.frameId = null;
    }
    if (!active) {
      this.metrics.fps = 0;
      this.onMetrics?.(this.getMetrics());
    }
  }

  getMetrics(): OfficeAnimationMetrics { return { ...this.metrics }; }

  dispose(): void { this.setActive(false); }

  private readonly tick: FrameRequestCallback = time => {
    this.frameId = null;
    if (!this.active) return;
    const interval = 1000 / 30;
    const elapsed = time - this.lastDraw;
    // Keep the target phase across irregular RAF callbacks; skip missed intervals without catch-up draws.
    if (elapsed >= interval - 0.5) {
      const start = performance.now();
      this.draw(time);
      this.metrics.drawMs = performance.now() - start;
      this.metrics.frames += 1;
      this.sampleFrames += 1;
      this.lastDraw = Number.isFinite(elapsed)
        ? this.lastDraw + Math.floor((elapsed + 0.5) / interval) * interval
        : time;
      if (!this.sampleStart) this.sampleStart = time;
      if (time - this.sampleStart >= 1000) {
        this.metrics.fps = this.sampleFrames * 1000 / (time - this.sampleStart);
        this.sampleStart = time;
        this.sampleFrames = 0;
        this.onMetrics?.(this.getMetrics());
      }
    }
    if (this.active) this.frameId = this.scheduler.request(this.tick);
  };
}
