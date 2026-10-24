import { animate } from 'motion/mini';
import type { OfficeCamera } from './officeCamera';
import type { OfficeTaskEffect } from './officeFeedback';
import type { OfficeHitRegion } from './officeRenderer';

interface Badge {
  anchor: HTMLDivElement;
  label: HTMLSpanElement;
  animation: ReturnType<typeof animate>;
}

/** Finite compositor animations. Positions follow the scene clock without frame-driven React renders or layout reads. */
export class OfficeFeedbackLayer {
  private readonly badges = new Map<string, Badge>();

  sync(root: HTMLDivElement | null, effects: readonly OfficeTaskEffect[], hits: readonly OfficeHitRegion[], camera: OfficeCamera,
    now: number, labels: Readonly<Record<string, string>>): void {
    const active = new Set<string>();
    if (root) for (const effect of effects) {
      const hit = hits.find(hit => hit.sourceKey === effect.sourceKey);
      if (!hit || effect.expiresAt <= now) continue;
      const x = (hit.x + hit.width / 2 - camera.x) / camera.width * 100;
      const y = (hit.y + Math.min(26, hit.height * .12) - camera.y) / camera.height * 100;
      if (x < 0 || x > 100 || y < 0 || y > 100) continue;
      active.add(effect.identity);
      let badge = this.badges.get(effect.identity);
      if (!badge) {
        badge = this.create(root, effect, Math.max(.1, (effect.expiresAt - now) / 1000));
        this.badges.set(effect.identity, badge);
      }
      const left = `${x.toFixed(3)}%`, top = `${y.toFixed(3)}%`;
      if (badge.anchor.style.left !== left) badge.anchor.style.left = left;
      if (badge.anchor.style.top !== top) badge.anchor.style.top = top;
      const label = labels[effect.outcome] ?? effect.outcome;
      if (badge.label.textContent !== label) badge.label.textContent = label;
    }
    for (const [id, badge] of this.badges) if (!active.has(id)) {
      badge.animation.stop(); badge.anchor.remove(); this.badges.delete(id);
    }
  }

  clear(): void {
    for (const badge of this.badges.values()) { badge.animation.stop(); badge.anchor.remove(); }
    this.badges.clear();
  }

  private create(root: HTMLDivElement, effect: OfficeTaskEffect, duration: number): Badge {
    const anchor = document.createElement('div'), chip = document.createElement('div');
    anchor.className = 'office-feedback-anchor'; anchor.dataset.outcome = effect.outcome;
    chip.className = 'office-feedback-chip';
    const icon = document.createElement('span'), label = document.createElement('span');
    icon.className = 'office-feedback-icon'; label.className = 'office-feedback-label';
    icon.textContent = effect.outcome === 'SUCCEEDED' ? '✓' : effect.outcome === 'FAILED' ? '!' : effect.outcome === 'WAITING_USER' ? '…' : '–';
    chip.append(icon, label); anchor.append(chip); root.append(anchor);
    const animation = animate(chip, {
      opacity: [0, 1, 1, 0],
      transform: ['translateY(12px) scale(.78)', 'translateY(-3px) scale(1.04)', 'translateY(-1px) scale(1)', 'translateY(-18px) scale(.96)'],
    }, { duration, times: [0, .14, .78, 1], ease: 'easeOut' });
    return { anchor, label, animation };
  }
}
