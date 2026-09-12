import type { GameAudio } from './audio';
import { getDriftFeedback, getIncomingThreat, getRocketTarget } from './race-feedback';
import type { GameEvent, Racer, RaceState } from './types';

export function threatProtection(player: Racer, eta: number): 'shield' | 'invulnerable' | 'expiring' | 'none' {
  // Do not silence an alert for protection that will expire before the predicted impact.
  if (player.shield >= eta + 0.12) return 'shield';
  if (player.invulnerable >= eta + 0.12) return 'invulnerable';
  return player.shield > 0 || player.invulnerable > 0 ? 'expiring' : 'none';
}

/** Transient feedback uses race time, so pausing never consumes a driving cue. */
export class RaceFeedbackHUD {
  private readonly elements = new Map<string, HTMLElement>();
  private wasReady = false;
  private wasCharged = false;
  private releaseUntil = 0;
  private confirmationUntil = 0;
  private warningAt = 0;

  constructor(private readonly root: HTMLElement, private readonly audio: GameAudio,
    private readonly isTouch: () => boolean,
    private readonly project: (racer: Racer) => { x: number; y: number } | null) {}

  private element(id: string): HTMLElement {
    let element = this.elements.get(id);
    if (!element) {
      element = this.root.querySelector<HTMLElement>(`#${id}`)!;
      this.elements.set(id, element);
    }
    return element;
  }

  private text(id: string, value: string) {
    const element = this.element(id);
    if (element.textContent !== value) element.textContent = value;
  }

  private hide() {
    for (const id of ['drift-indicator', 'threat-warning', 'target-lock', 'target-reticle', 'combat-confirmation']) {
      this.element(id).hidden = true;
    }
    document.body.classList.remove('has-threat');
  }

  reset() {
    this.wasReady = false;
    this.wasCharged = false;
    this.releaseUntil = this.confirmationUntil = this.warningAt = 0;
    this.hide();
  }

  event(event: GameEvent, state: RaceState) {
    const player = state.racers[0];
    if (event.racer === player.id) {
      if (event.type === 'drift') this.releaseUntil = state.time + 1.05;
      if (event.type === 'hit' || event.type === 'reset' ||
        (event.type === 'collision' && event.text !== 'PROJECTILE_BLOCKED' && player.boostTime <= 0)) this.releaseUntil = 0;
      if (event.type === 'reset') this.wasReady = false;
      if (event.type === 'shield' && event.text === 'BLOCKED!') this.confirm('护盾拦截成功', state.time, 'shield');
    } else if (event.type === 'hit' && event.text === 'DIRECT HIT!') {
      const opponent = state.racers.find(racer => racer.id === event.racer);
      this.confirm(`命中 ${opponent?.name ?? '对手'}`, state.time, 'hit');
    }
  }

  private confirm(text: string, now: number, kind: 'shield' | 'hit') {
    this.text('combat-confirmation-text', text);
    this.element('combat-confirmation').dataset.kind = kind;
    this.confirmationUntil = now + 1.15;
  }

  update(state: RaceState) {
    if (state.phase !== 'racing') {
      if (state.phase !== 'paused') this.reset();
      else this.hide();
      return;
    }
    const player = state.racers[0];
    const drift = getDriftFeedback(player);
    if (drift.ready && !this.wasReady) this.audio.play('driftReady');
    if (drift.charged && !this.wasCharged) this.audio.play('charged');
    this.wasReady = drift.ready;
    this.wasCharged = drift.charged;
    const released = !drift.active && state.time < this.releaseUntil;
    const driftPanel = this.element('drift-indicator');
    driftPanel.hidden = !drift.active && !released;
    driftPanel.dataset.state = released ? 'released' : drift.ready ? 'ready' : 'building';
    this.text('drift-label', released ? '出弯小喷' : drift.ready ? '小喷就绪' : '漂移积累');
    this.text('drift-hint', released ? '加速已触发' : drift.ready ? this.isTouch() ? '松开漂移释放' : '松开空格释放' : '保持漂移');
    const progress = Math.round((released ? 1 : drift.progress) * 100);
    this.element('drift-fill').style.width = `${progress}%`;
    const progressbar = driftPanel.querySelector('[role="progressbar"]')!;
    progressbar.setAttribute('aria-valuenow', String(progress));
    progressbar.setAttribute('aria-valuetext', released ? '出弯加速已触发' : drift.ready ? '小喷就绪，松开漂移释放' : `积累 ${progress}%`);
    this.element('drift-charge').hidden = drift.charge === null;
    if (drift.charge !== null) this.text('drift-charge', drift.charged ? '道具已强化 · 随时可释放' : `道具强化 ${Math.round(drift.charge * 100)}% · 持续漂移充能`);

    const target = getRocketTarget(state);
    const holdingRocket = player.item === 'rocket';
    this.element('target-lock').hidden = !holdingRocket;
    this.element('target-lock').classList.toggle('is-locked', !!target);
    if (holdingRocket) this.text('target-label', target ? `锁定 ${target.name} · ${Math.round(target.distance)} m` : '前方暂无目标 · 靠近后锁定');
    const targetRacer = target && state.racers.find(racer => racer.id === target.racerId);
    const point = targetRacer ? this.project(targetRacer) : null;
    const reticle = this.element('target-reticle');
    reticle.hidden = !point;
    if (point) {
      reticle.style.left = `${point.x}px`;
      reticle.style.top = `${point.y}px`;
    }

    const threat = getIncomingThreat(state);
    const warning = this.element('threat-warning');
    warning.hidden = !threat;
    document.body.classList.toggle('has-threat', !!threat);
    if (threat) {
      const protection = threatProtection(player, threat.eta);
      const protectedNow = protection === 'shield' || protection === 'invulnerable';
      const directions = { left: '左后方', right: '右后方', rear: '后方', front: '前方' };
      warning.dataset.direction = threat.direction;
      warning.dataset.protected = String(protectedNow);
      warning.classList.toggle('is-urgent', threat.urgent && !protectedNow);
      this.text('threat-label', `${directions[threat.direction]}火箭接近`);
      this.text('threat-distance', `${Math.max(1, Math.round(threat.distance))} m`);
      this.text('threat-action', protection === 'shield' ? '护盾生效 · 可抵挡一次攻击' : protection === 'invulnerable' ? '受击保护生效 · 留意来袭' : protection === 'expiring' ? '保护即将结束 · 寻找掩护' : player.item === 'shield' ? this.isTouch() ? '点道具开启护盾' : '按 E 开启护盾' : '注意来袭方位 · 寻找障碍掩护');
      if (!protectedNow && state.time >= this.warningAt) {
        this.audio.play('warning');
        this.warningAt = state.time + (threat.urgent ? 0.72 : 1.15);
      }
    }
    this.element('combat-confirmation').hidden = state.time >= this.confirmationUntil;
  }
}
