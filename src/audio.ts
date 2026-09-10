import type { GameEvent, GamePhase } from './types';
import { RallyMusic } from './music';

type SoundType = GameEvent['type'] | 'click' | 'go';
type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

/** Small, entirely procedural soundtrack. No requests, samples, or autoplay. */
export class GameAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private effectsBus: GainNode | null = null;
  private musicDuck: GainNode | null = null;
  private music: RallyMusic | null = null;
  private phase: GamePhase = 'menu';
  private focused = true;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private tireGain: GainNode | null = null;
  private engineOscillators: OscillatorNode[] = [];
  private noiseBuffer: AudioBuffer | null = null;
  private readonly sources = new Set<AudioScheduledSourceNode>();
  private readonly lastPlayed = new Map<SoundType, number>();
  private _muted = false;
  private _musicEnabled = true;
  private _musicVolume = 0.4;
  private _effectsVolume = 0.8;
  private disposed = false;

  constructor() {
    try {
      this._muted = localStorage.getItem('sand-rally-muted') === 'true';
      this._musicEnabled = localStorage.getItem('sand-rally-music-enabled') !== 'false';
      this._musicVolume = this.readVolume('sand-rally-music-volume', 0.4);
      this._effectsVolume = this.readVolume('sand-rally-effects-volume', 0.8);
    } catch {
      // Private browsing/storage policies must not prevent a race from starting.
    }
  }

  get muted(): boolean {
    return this._muted;
  }

  get musicEnabled() { return this._musicEnabled; }
  get musicVolume() { return this._musicVolume; }
  get effectsVolume() { return this._effectsVolume; }
  get snapshot() {
    return { contextState: this.context?.state ?? 'locked', muted: this._muted,
      musicEnabled: this._musicEnabled, musicVolume: this._musicVolume,
      effectsVolume: this._effectsVolume, music: this.music?.snapshot ?? null };
  }

  async unlock(): Promise<void> {
    if (this.disposed) return;
    try {
      if (!this.context) {
        const Context = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
        if (!Context) return;
        this.context = new Context({ latencyHint: 'interactive' });
        this.buildGraph(this.context);
      }
      if (this.context.state === 'suspended') await this.context.resume();
      this.refreshMix();
    } catch {
      // Audio is optional: unsupported/blocked WebAudio remains silently playable.
    }
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    try {
      localStorage.setItem('sand-rally-muted', String(muted));
    } catch {
      // Keep the in-memory preference when persistence is unavailable.
    }
    this.refreshMix();
  }

  setMusicEnabled(enabled: boolean) {
    this._musicEnabled = enabled;
    this.persist('sand-rally-music-enabled', String(enabled));
    this.refreshMix();
  }

  setMusicVolume(volume: number) {
    if (!Number.isFinite(volume)) return;
    this._musicVolume = Math.max(0, Math.min(1, volume));
    this.persist('sand-rally-music-volume', String(this._musicVolume));
    this.refreshMix();
  }

  setEffectsVolume(volume: number) {
    if (!Number.isFinite(volume)) return;
    this._effectsVolume = Math.max(0, Math.min(1, volume));
    this.persist('sand-rally-effects-volume', String(this._effectsVolume));
    this.refreshMix();
  }

  setPhase(phase: GamePhase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.refreshMix();
  }

  setFocused(focused: boolean) {
    this.focused = focused;
    this.refreshMix();
  }

  private readVolume(key: string, fallback: number) {
    const value = localStorage.getItem(key);
    const number = value === null ? NaN : Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
  }

  private persist(key: string, value: string) {
    try { localStorage.setItem(key, value); } catch { /* Audio also works without browser storage. */ }
  }

  private refreshMix() {
    const context = this.context;
    if (!context || this.disposed || context.state === 'closed') return;
    const visible = this.focused && !document.hidden;
    this.master?.gain.setTargetAtTime(!this._muted && visible ? 0.66 : 0, context.currentTime, 0.025);
    this.effectsBus?.gain.setTargetAtTime(this._effectsVolume, context.currentTime, 0.035);
    this.music?.setVolume(this._musicVolume);
    this.music?.setMode(visible ? this.phase : 'hidden');
    this.music?.setEnabled(this._musicEnabled && !this._muted && visible && context.state === 'running');
  }

  update(speed: number, boosting: boolean, drifting: boolean, active: boolean): void {
    const context = this.context;
    if (!context || this.disposed || context.state !== 'running') return;
    const now = context.currentTime;
    const velocity = Math.min(1.3, Math.max(0, Number.isFinite(speed) ? Math.abs(speed) / 80 : 0));
    this.music?.setIntensity(active ? boosting ? 1 : drifting ? 0.65 : velocity * 0.4 : 0);
    // A slight gear-shaped pitch dip adds texture without sharp, tiring revs.
    const gear = Math.min(4, Math.floor(velocity * 4.2));
    const revs = 42 + velocity * 93 - gear * 9 + (boosting ? 13 : 0);
    const frequencies = [revs, revs * 1.997, revs * 0.501];
    this.engineOscillators.forEach((oscillator, index) => {
      oscillator.frequency.setTargetAtTime(frequencies[index], now, 0.11);
    });
    this.engineFilter?.frequency.setTargetAtTime(260 + velocity * 650 + (boosting ? 220 : 0), now, 0.14);
    this.engineGain?.gain.setTargetAtTime(active ? 0.026 + velocity * 0.029 : 0, now, active ? 0.14 : 0.04);
    this.windFilter?.frequency.setTargetAtTime(500 + velocity * 1800 + (boosting ? 650 : 0), now, 0.18);
    this.windGain?.gain.setTargetAtTime(active ? velocity * velocity * 0.038 + (boosting ? 0.033 : 0) : 0, now, 0.08);
    this.tireGain?.gain.setTargetAtTime(active && drifting && velocity > 0.17 ? 0.036 : 0, now, 0.05);
  }

  play(type: SoundType): void {
    const context = this.context;
    if (!context || context.state !== 'running' || this._muted || this.disposed) return;
    const now = context.currentTime;
    const cooldown = type === 'countdown' ? 0.35 : type === 'finish' ? 1 : type === 'collision' ? 0.16 : type === 'drift' ? 0.15 : 0.065;
    if (now - (this.lastPlayed.get(type) ?? -100) < cooldown) return;
    this.lastPlayed.set(type, now);
    if (this.musicDuck && ['hit', 'collision', 'fire', 'pickup', 'countdown', 'go'].includes(type)) {
      // Briefly make space for actionable sounds; the music returns smoothly afterward.
      this.musicDuck.gain.cancelScheduledValues(now);
      this.musicDuck.gain.setTargetAtTime(type === 'countdown' || type === 'go' ? 0.45 : 0.64, now, 0.012);
      this.musicDuck.gain.setTargetAtTime(1, now + 0.14, 0.12);
    }

    switch (type) {
      case 'click':
        this.tone(440, 560, 0.055, 0.04, 'sine');
        break;
      case 'countdown':
        this.tone(392, 392, 0.13, 0.085, 'sine');
        this.tone(784, 784, 0.1, 0.021, 'triangle');
        break;
      case 'go':
        this.tone(523, 523, 0.13, 0.085, 'sine');
        this.tone(1046, 1046, 0.33, 0.067, 'sine', 0.09);
        break;
      case 'pickup':
        [659, 988, 1318].forEach((frequency, index) => {
          this.tone(frequency, frequency, 0.12, 0.053, 'sine', index * 0.065);
        });
        break;
      case 'fire':
        this.tone(190, 45, 0.25, 0.095, 'triangle');
        this.noise(0.25, 0.09, 1400, 'lowpass');
        break;
      case 'hit':
        this.tone(80, 29, 0.27, 0.15, 'sine');
        this.noise(0.23, 0.16, 650, 'lowpass');
        break;
      case 'collision':
        this.tone(110, 42, 0.16, 0.09, 'triangle');
        this.noise(0.12, 0.065, 1100, 'bandpass');
        break;
      case 'shield':
        this.tone(400, 820, 0.32, 0.052, 'sine');
        this.tone(1046, 1568, 0.26, 0.026, 'sine', 0.05);
        this.noise(0.18, 0.022, 2100, 'bandpass');
        break;
      case 'boost':
        this.tone(85, 230, 0.4, 0.06, 'triangle');
        this.noise(0.42, 0.087, 1700, 'bandpass');
        break;
      case 'drift':
        this.tone(660, 990, 0.13, 0.038, 'sine');
        this.tone(1320, 1320, 0.13, 0.02, 'sine', 0.08);
        break;
      case 'lap':
        [523, 659, 784].forEach((frequency, index) => {
          this.tone(frequency, frequency, 0.19, 0.06, 'sine', index * 0.1);
        });
        break;
      case 'finish':
        [392, 523, 659, 784, 1046].forEach((frequency, index) => {
          this.tone(frequency, frequency, index === 4 ? 0.62 : 0.25, 0.062, 'sine', index * 0.14);
        });
        break;
      case 'reset':
        this.tone(350, 160, 0.2, 0.055, 'sine');
        break;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.music?.dispose();
    this.music = null;
    for (const source of this.sources) {
      try { source.stop(); } catch { /* Already-ended one-shot. */ }
      source.disconnect();
    }
    this.sources.clear();
    this.engineOscillators = [];
    this.master?.disconnect();
    this.effectsBus?.disconnect();
    this.musicDuck?.disconnect();
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {});
    this.context = null;
    this.master = null;
    this.effectsBus = null;
    this.musicDuck = null;
    this.engineGain = null;
    this.engineFilter = null;
    this.windGain = null;
    this.windFilter = null;
    this.tireGain = null;
    this.noiseBuffer = null;
    this.lastPlayed.clear();
  }

  private buildGraph(context: AudioContext): void {
    const master = context.createGain();
    master.gain.value = this._muted ? 0 : 0.66;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -17;
    limiter.knee.value = 16;
    limiter.ratio.value = 4;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.18;
    master.connect(limiter);
    limiter.connect(context.destination);
    this.master = master;
    const effectsBus = context.createGain();
    effectsBus.gain.value = this._effectsVolume;
    effectsBus.connect(master);
    this.effectsBus = effectsBus;
    const musicDuck = context.createGain();
    musicDuck.gain.value = 1;
    musicDuck.connect(master);
    this.musicDuck = musicDuck;
    this.music = new RallyMusic(context, musicDuck);
    context.addEventListener('statechange', () => this.refreshMix());

    const engineGain = context.createGain();
    engineGain.gain.value = 0;
    const engineFilter = context.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 380;
    engineFilter.Q.value = 0.6;
    engineFilter.connect(engineGain);
    engineGain.connect(effectsBus);
    this.engineGain = engineGain;
    this.engineFilter = engineFilter;

    const oscillatorSpecs: [OscillatorType, number, number][] = [
      ['sawtooth', 46, 0.6], ['triangle', 92, 0.28], ['sine', 23, 0.5],
    ];
    oscillatorSpecs.forEach(([type, frequency, level]) => {
      const oscillator = context.createOscillator();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      const gain = context.createGain();
      gain.gain.value = level;
      oscillator.connect(gain);
      gain.connect(engineFilter);
      oscillator.start();
      this.sources.add(oscillator);
      this.engineOscillators.push(oscillator);
    });

    this.noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const samples = this.noiseBuffer.getChannelData(0);
    for (let index = 0; index < samples.length; index++) samples[index] = Math.random() * 2 - 1;

    const wind = this.createContinuousNoise(1000, 0.6);
    this.windGain = wind.gain;
    this.windFilter = wind.filter;
    const tire = this.createContinuousNoise(1850, 2.4);
    this.tireGain = tire.gain;
  }

  private createContinuousNoise(frequency: number, resonance: number): { gain: GainNode; filter: BiquadFilterNode } {
    const context = this.context!;
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = resonance;
    const gain = context.createGain();
    gain.gain.value = 0;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.effectsBus!);
    source.start();
    this.sources.add(source);
    return { gain, filter };
  }

  private tone(startFrequency: number, endFrequency: number, duration: number, volume: number, wave: OscillatorType, delay = 0): void {
    const context = this.context!;
    const start = context.currentTime + delay;
    const oscillator = context.createOscillator();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(startFrequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), start + duration);
    const gain = context.createGain();
    this.envelope(gain.gain, start, duration, volume);
    oscillator.connect(gain);
    gain.connect(this.effectsBus!);
    this.sources.add(oscillator);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
      this.sources.delete(oscillator);
    };
    oscillator.start(start);
    oscillator.stop(start + duration + 0.025);
  }

  private noise(duration: number, volume: number, frequency: number, type: BiquadFilterType): void {
    const context = this.context!;
    const start = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = 0.7;
    const gain = context.createGain();
    this.envelope(gain.gain, start, duration, volume);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.effectsBus!);
    this.sources.add(source);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
      this.sources.delete(source);
    };
    source.start(start);
    source.stop(start + duration + 0.025);
  }

  private envelope(gain: AudioParam, start: number, duration: number, volume: number): void {
    gain.setValueAtTime(0.0001, start);
    gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), start + Math.min(0.015, duration * 0.15));
    gain.exponentialRampToValueAtTime(0.0001, start + duration);
  }
}
