import { arpMidiAt, bassForBar, chordAtBar, leadForBar, menuForBar, midiFrequency, SCORE_BARS, STEPS_PER_BAR } from './music-score';

export type MusicMode = 'menu' | 'countdown' | 'racing' | 'paused' | 'finished' | 'hidden';
export const MUSIC_TITLE = 'Dustline · 荒原电台';
export const MUSIC_BPM = 132;

const BEAT = 60 / MUSIC_BPM;
const STEP = BEAT / 4;
const LOOKAHEAD = 0.12;
const CLOCK_MS = 32;
const FLOOR = 0.0001;
const clamp = (value: number, fallback = 0): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : fallback));
const silentMode = (mode: MusicMode): boolean => mode === 'paused' || mode === 'hidden';

type Voice = {
  gain: GainNode;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  remaining: number;
  stopping: boolean;
};

/** Original 32-bar synthwave score with an audio-clock, not animation-frame, transport. */
export class RallyMusic {
  private mode: MusicMode = 'menu';
  private effectiveMode: MusicMode = 'menu';
  private pendingMode: MusicMode | null = null;
  private enabled = false;
  private volume = 0.4;
  private intensity = 0;
  private disposed = false;
  private graphDisposed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextTime = 0;
  private transportStep = 0;
  private audibleBar = 1;
  private needsPad = true;
  private scheduledNotes = 0;
  private readonly voices = new Set<Voice>();
  private readonly activeSources = new Set<AudioScheduledSourceNode>();
  private readonly nodes = new Set<AudioNode>();
  private readonly master: GainNode;
  private readonly padBus: GainNode;
  private readonly leadBus: GainNode;
  private readonly bassBus: GainNode;
  private readonly drumBus: GainNode;
  private readonly arpBus: GainNode;
  private readonly delaySend: GainNode;
  private readonly reverbSend: GainNode;
  private readonly delayFeedback: GainNode;
  private readonly noiseBuffer: AudioBuffer;

  constructor(private readonly context: AudioContext, output: AudioNode) {
    this.master = this.keep(context.createGain());
    this.master.gain.value = 0;
    // A soft safety compressor only catches dense drum/lead coincidences.
    const glue = this.keep(context.createDynamicsCompressor());
    glue.threshold.value = -12;
    glue.knee.value = 15;
    glue.ratio.value = 2.3;
    glue.attack.value = 0.018;
    glue.release.value = 0.2;
    this.master.connect(glue);
    glue.connect(output);
    this.padBus = this.bus(0.9);
    this.leadBus = this.bus(0.55);
    this.bassBus = this.bus(0);
    this.drumBus = this.bus(0);
    this.arpBus = this.bus(0);

    this.delaySend = this.keep(context.createGain());
    this.delaySend.gain.value = 0.17;
    this.leadBus.connect(this.delaySend);
    this.arpBus.connect(this.delaySend);
    const delayL = this.keep(context.createDelay(1));
    const delayR = this.keep(context.createDelay(1));
    delayL.delayTime.value = BEAT * 0.75;
    delayR.delayTime.value = BEAT * 0.5;
    const dampL = this.filter('lowpass', 2450, 0.5);
    const dampR = this.filter('lowpass', 1950, 0.5);
    const left = this.pan(-0.48), right = this.pan(0.48);
    const echoReturn = this.keep(context.createGain());
    echoReturn.gain.value = 0.44;
    this.delayFeedback = this.keep(context.createGain());
    this.delayFeedback.gain.value = 0.23;
    this.delaySend.connect(delayL);
    delayL.connect(dampL); dampL.connect(left); left.connect(echoReturn);
    dampL.connect(delayR); delayR.connect(dampR); dampR.connect(right); right.connect(echoReturn);
    dampR.connect(this.delayFeedback); this.delayFeedback.connect(delayL);
    echoReturn.connect(this.master);

    this.reverbSend = this.keep(context.createGain());
    this.reverbSend.gain.value = 0.085;
    this.padBus.connect(this.reverbSend);
    this.leadBus.connect(this.reverbSend);
    this.drumBus.connect(this.reverbSend);
    const reverb = this.keep(context.createConvolver());
    reverb.buffer = this.roomImpulse();
    const roomDamp = this.filter('lowpass', 3200, 0.6);
    const roomReturn = this.keep(context.createGain());
    roomReturn.gain.value = 0.36;
    this.reverbSend.connect(reverb); reverb.connect(roomDamp); roomDamp.connect(roomReturn); roomReturn.connect(this.master);

    this.noiseBuffer = context.createBuffer(1, Math.max(1, Math.floor(context.sampleRate)), context.sampleRate);
    const noise = this.noiseBuffer.getChannelData(0);
    let seed = 0x51a7d;
    for (let i = 0; i < noise.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      noise[i] = (seed / 0x100000000) * 2 - 1;
    }
    context.addEventListener('statechange', this.handleContextState);
    // No source, timer or sound is started by construction.
  }

  setMode(mode: MusicMode): void {
    if (this.disposed) return;
    this.mode = mode;
    if (silentMode(mode)) {
      this.pendingMode = null;
      this.stopTransport();
    } else if (this.timer !== null) {
      this.pendingMode = mode !== this.effectiveMode ? mode : null;
    } else {
      this.startTransport();
    }
  }

  setIntensity(value: number): void {
    if (this.disposed) return;
    this.intensity = clamp(value);
    const level = this.effectiveMode === 'racing' ? this.intensity * 0.58 : 0;
    this.smooth(this.arpBus.gain, level, this.now(), 0.13);
  }

  setVolume(volume: number): void {
    if (this.disposed) return;
    this.volume = clamp(volume, this.volume);
    this.smooth(this.master.gain, this.timer !== null ? this.volume : 0, this.now(), 0.055);
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.enabled = enabled;
    if (enabled) this.startTransport();
    else this.stopTransport();
  }

  get snapshot(): { mode: MusicMode; enabled: boolean; volume: number; intensity: number; bar: number; activeSources: number; timerActive: boolean; scheduledNotes: number } {
    return {
      mode: this.mode, enabled: this.enabled, volume: this.volume, intensity: this.intensity, bar: this.audibleBar,
      activeSources: this.activeSources.size, timerActive: this.timer !== null, scheduledNotes: this.scheduledNotes,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    this.context.removeEventListener('statechange', this.handleContextState);
    this.stopTransport();
    // Running voices get their short anti-click release, then onended tears down
    // the graph. A suspended/closed context cannot deliver those events.
    if (this.context.state !== 'running') {
      for (const voice of [...this.voices]) this.releaseVoice(voice);
    }
    if (this.voices.size === 0) this.disposeGraph();
  }

  private now(): number {
    return Math.max(0, Number.isFinite(this.context.currentTime) ? this.context.currentTime : 0);
  }

  private readonly handleContextState = (): void => {
    if (this.disposed) return;
    if (this.context.state === 'running') this.startTransport();
    else this.stopTransport();
  };

  private startTransport(): void {
    if (this.disposed || !this.enabled || silentMode(this.mode) || this.context.state !== 'running' || this.timer !== null) return;
    const now = this.now();
    // Resume at the next beat, never replay notes accumulated while asleep.
    this.transportStep = Math.ceil(this.transportStep / 4) * 4;
    this.nextTime = now + 0.065;
    this.effectiveMode = this.mode;
    this.pendingMode = null;
    this.needsPad = true;
    this.applyLayers(this.nextTime);
    this.smooth(this.delayFeedback.gain, 0.23, now, 0.04);
    this.smooth(this.master.gain, this.volume, this.nextTime, 0.095);
    this.timer = setInterval(this.pump, CLOCK_MS);
    this.pump();
  }

  private stopTransport(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const now = this.now();
    this.smooth(this.master.gain, 0, now, 0.018);
    this.smooth(this.delayFeedback.gain, 0, now, 0.018);
    for (const voice of this.voices) {
      if (voice.stopping) continue;
      voice.stopping = true;
      this.smooth(voice.gain.gain, 0, now, 0.009);
      for (const source of voice.sources) {
        try { source.stop(now + 0.055); } catch { /* Already-ended scheduled source. */ }
      }
    }
    if (this.context.state !== 'running') {
      for (const voice of [...this.voices]) this.releaseVoice(voice);
    }
  }

  private readonly pump = (): void => {
    if (!this.enabled || silentMode(this.mode) || this.disposed || this.context.state !== 'running') {
      this.stopTransport();
      return;
    }
    const now = this.now();
    // Background throttling or a stalled tab must not produce a catch-up burst.
    if (this.nextTime < now - 0.035) {
      this.stopTransport();
      this.startTransport();
      return;
    }
    let safety = 0;
    while (this.nextTime < now + LOOKAHEAD && safety++ < 8) {
      const step = this.transportStep % STEPS_PER_BAR;
      const bar = Math.floor(this.transportStep / STEPS_PER_BAR) % SCORE_BARS;
      if (this.pendingMode && step % 4 === 0) {
        this.effectiveMode = this.pendingMode;
        this.pendingMode = null;
        this.applyLayers(this.nextTime);
      }
      this.audibleBar = bar + 1;
      const time = Math.max(now + 0.003, this.nextTime + (step % 2 ? STEP * 0.105 : 0));
      this.scheduleStep(bar, step, time);
      this.nextTime += STEP;
      this.transportStep = (this.transportStep + 1) % (SCORE_BARS * STEPS_PER_BAR);
    }
  };

  private applyLayers(time: number): void {
    const race = this.effectiveMode === 'racing';
    const finish = this.effectiveMode === 'finished';
    const countdown = this.effectiveMode === 'countdown';
    this.smooth(this.padBus.gain, race ? 0.73 : 0.97, time, 0.16);
    this.smooth(this.leadBus.gain, race ? 0.87 : finish ? 0.68 : 0.52, time, 0.13);
    this.smooth(this.bassBus.gain, race ? 0.93 : 0, time, 0.11);
    this.smooth(this.drumBus.gain, race ? 0.94 : countdown ? 0.18 : 0, time, 0.09);
    this.smooth(this.arpBus.gain, race ? this.intensity * 0.58 : 0, time, 0.14);
  }

  private scheduleStep(bar: number, step: number, time: number): void {
    const race = this.effectiveMode === 'racing';
    if (this.needsPad || (bar % 2 === 0 && step === 0)) {
      const remainingSteps = 32 - ((bar % 2) * 16 + step);
      this.pad(chordAtBar(bar).notes, time, Math.max(STEP * 2, remainingSteps * STEP));
      this.needsPad = false;
    }
    const melody = race || this.effectiveMode === 'finished' ? leadForBar(bar) : menuForBar(bar);
    for (const note of melody) if (note.step === step) {
      this.lead(note.midi, time, note.length * STEP, note.velocity, false);
    }
    if (this.effectiveMode === 'countdown' && step === 0) this.kick(time, 0.52);
    if (!race) return;
    for (const note of bassForBar(bar)) if (note.step === step) {
      this.bass(note.midi, time, note.length * STEP, note.velocity);
    }
    const breakSection = bar >= 16 && bar < 24;
    const kickSteps = breakSection ? [0, 8] : bar >= 8 && bar < 16 ? [0, 6, 8, 12] : [0, 4, 8, 12];
    if (kickSteps.includes(step)) this.kick(time, step === 0 ? 0.98 : 0.86);
    if ((!breakSection && step === 4) || step === 12) this.snare(time, 0.8);
    if (bar % 8 === 7 && (step === 14 || step === 15)) this.snare(time, step === 14 ? 0.35 : 0.5);
    if (step % (breakSection ? 4 : 2) === 0) this.hat(time, step % 4 === 2 ? 0.62 : 0.39, step === 14);
    if (this.intensity > 0.42) {
      const busy = this.intensity > 0.72;
      if (busy || step % 2 === 0) this.lead(arpMidiAt(bar, step), time, STEP * 0.68, 0.45, true);
      if (this.intensity > 0.55 && step % 2 === 1) this.hat(time, 0.23 + this.intensity * 0.08, false);
    }
  }

  private pad(notes: readonly number[], requestedTime: number, length: number): void {
    const time = this.safeTime(requestedTime);
    notes.forEach((midi, index) => {
      const duration = length + 0.35;
      const voice = this.voice(this.padBus, (index - 2) * 0.23);
      this.adsr(voice.gain.gain, time, duration, 0.034, Math.min(0.48, length * 0.2), 0.76, 0.38);
      const filter = this.voiceFilter(voice, 'lowpass', 780 + index * 90, 0.55);
      filter.connect(voice.gain);
      const a = this.oscillator(voice, 'triangle', midiFrequency(midi), -7);
      const b = this.oscillator(voice, 'sawtooth', midiFrequency(midi), 7);
      const bLevel = this.voiceGain(voice, 0.3);
      a.connect(filter); b.connect(bLevel); bLevel.connect(filter);
      this.commit(voice, time, duration);
    });
  }

  private lead(midi: number, requestedTime: number, length: number, velocity: number, arp: boolean): void {
    const time = this.safeTime(requestedTime);
    const duration = length + (arp ? 0.11 : 0.19);
    const voice = this.voice(arp ? this.arpBus : this.leadBus, arp ? (midi % 2 ? -0.28 : 0.28) : -0.06);
    this.adsr(voice.gain.gain, time, duration, (arp ? 0.057 : 0.087) * velocity, arp ? 0.007 : 0.013, arp ? 0.22 : 0.57, arp ? 0.1 : 0.17);
    const filter = this.voiceFilter(voice, 'lowpass', arp ? 2250 : 2400, 0.75);
    filter.frequency.setValueAtTime(arp ? 3100 : 3250, time);
    filter.frequency.exponentialRampToValueAtTime(arp ? 1350 : 1650, time + Math.max(0.05, length));
    filter.connect(voice.gain);
    const frequency = midiFrequency(midi);
    const a = this.oscillator(voice, 'triangle', frequency, -4);
    const b = this.oscillator(voice, 'sawtooth', frequency, 5);
    const bLevel = this.voiceGain(voice, arp ? 0.19 : 0.34);
    a.frequency.setValueAtTime(frequency * 0.997, time);
    a.frequency.exponentialRampToValueAtTime(frequency, time + 0.028);
    a.connect(filter); b.connect(bLevel); bLevel.connect(filter);
    const send = this.voiceGain(voice, arp ? 0.17 : 0.07);
    voice.gain.connect(send); send.connect(this.delaySend);
    this.commit(voice, time, duration);
  }

  private bass(midi: number, requestedTime: number, length: number, velocity: number): void {
    const time = this.safeTime(requestedTime);
    const voice = this.voice(this.bassBus, 0);
    const duration = length + 0.085;
    this.adsr(voice.gain.gain, time, duration, 0.145 * velocity, 0.009, 0.62, 0.075);
    const filter = this.voiceFilter(voice, 'lowpass', 420, 0.7);
    filter.frequency.setValueAtTime(820, time);
    filter.frequency.exponentialRampToValueAtTime(240, time + Math.min(0.18, length));
    filter.connect(voice.gain);
    const core = this.oscillator(voice, 'sawtooth', midiFrequency(midi), 0);
    const sub = this.oscillator(voice, 'sine', midiFrequency(midi) / 2, 0);
    const coreLevel = this.voiceGain(voice, 0.61);
    const subLevel = this.voiceGain(voice, 0.5);
    core.connect(coreLevel); coreLevel.connect(filter);
    sub.connect(subLevel); subLevel.connect(voice.gain);
    this.commit(voice, time, duration);
  }

  private kick(requestedTime: number, velocity: number): void {
    const time = this.safeTime(requestedTime);
    const voice = this.voice(this.drumBus, 0);
    this.adsr(voice.gain.gain, time, 0.32, velocity * 0.31, 0.0025, 0.14, 0.21);
    const body = this.oscillator(voice, 'sine', 140, 0);
    body.frequency.setValueAtTime(142, time);
    body.frequency.exponentialRampToValueAtTime(48, time + 0.095);
    body.frequency.exponentialRampToValueAtTime(42, time + 0.28);
    body.connect(voice.gain);
    const click = this.noise(voice);
    const clickFilter = this.voiceFilter(voice, 'bandpass', 2300, 0.5);
    const clickGain = this.voiceGain(voice, 0);
    this.adsr(clickGain.gain, time, 0.026, 0.13, 0.001, 0.05, 0.022);
    click.connect(clickFilter); clickFilter.connect(clickGain); clickGain.connect(voice.gain);
    this.commit(voice, time, 0.34);
  }

  private snare(requestedTime: number, velocity: number): void {
    const time = this.safeTime(requestedTime);
    const voice = this.voice(this.drumBus, 0.06);
    this.adsr(voice.gain.gain, time, 0.21, velocity * 0.18, 0.002, 0.33, 0.15);
    const noise = this.noise(voice);
    const snap = this.voiceFilter(voice, 'highpass', 1050, 0.55);
    const soften = this.voiceFilter(voice, 'lowpass', 5300, 0.6);
    noise.connect(snap); snap.connect(soften); soften.connect(voice.gain);
    const body = this.oscillator(voice, 'triangle', 185, 0);
    body.frequency.setValueAtTime(185, time);
    body.frequency.exponentialRampToValueAtTime(120, time + 0.11);
    const bodyGain = this.voiceGain(voice, 0);
    this.adsr(bodyGain.gain, time, 0.13, 0.46, 0.002, 0.2, 0.095);
    body.connect(bodyGain); bodyGain.connect(voice.gain);
    this.commit(voice, time, 0.23);
  }

  private hat(requestedTime: number, velocity: number, open: boolean): void {
    const time = this.safeTime(requestedTime);
    const duration = open ? 0.16 : 0.062;
    const voice = this.voice(this.drumBus, open ? 0.28 : -0.18);
    this.adsr(voice.gain.gain, time, duration, velocity * (open ? 0.059 : 0.044), 0.0015, 0.18, duration * 0.78);
    const noise = this.noise(voice);
    const high = this.voiceFilter(voice, 'highpass', 6200, 0.55);
    const low = this.voiceFilter(voice, 'lowpass', 10800, 0.5);
    noise.connect(high); high.connect(low); low.connect(voice.gain);
    this.commit(voice, time, duration + 0.015);
  }

  private safeTime(time: number): number {
    return Math.max(this.now() + 0.002, Number.isFinite(time) ? time : 0);
  }

  private voice(destination: AudioNode, pan: number): Voice {
    const gain = this.context.createGain();
    gain.gain.value = 0;
    const panner = this.createPan(pan);
    gain.connect(panner); panner.connect(destination);
    const voice: Voice = { gain, nodes: [gain, panner], sources: [], remaining: 0, stopping: false };
    return voice;
  }

  private oscillator(voice: Voice, type: OscillatorType, frequency: number, detune: number): OscillatorNode {
    const oscillator = this.context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.value = Math.max(20, Number.isFinite(frequency) ? frequency : 220);
    oscillator.detune.value = detune;
    voice.sources.push(oscillator);
    voice.nodes.push(oscillator);
    return oscillator;
  }

  private noise(voice: Voice): AudioBufferSourceNode {
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    voice.sources.push(source);
    voice.nodes.push(source);
    return source;
  }

  private voiceFilter(voice: Voice, type: BiquadFilterType, frequency: number, q: number): BiquadFilterNode {
    const filter = this.context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = Math.min(frequency, this.context.sampleRate * 0.45);
    filter.Q.value = q;
    voice.nodes.push(filter);
    return filter;
  }

  private voiceGain(voice: Voice, value: number): GainNode {
    const gain = this.context.createGain();
    gain.gain.value = value;
    voice.nodes.push(gain);
    return gain;
  }

  private commit(voice: Voice, time: number, duration: number): void {
    this.voices.add(voice);
    this.scheduledNotes++;
    voice.remaining = voice.sources.length;
    for (const source of voice.sources) {
      this.activeSources.add(source);
      source.onended = () => {
        this.activeSources.delete(source);
        voice.remaining--;
        if (voice.remaining <= 0) this.releaseVoice(voice);
      };
      source.start(time);
      source.stop(time + Math.max(0.025, duration));
    }
  }

  private releaseVoice(voice: Voice): void {
    if (!this.voices.delete(voice)) return;
    for (const source of voice.sources) {
      source.onended = null;
      this.activeSources.delete(source);
    }
    for (const node of voice.nodes) node.disconnect();
    if (this.disposed && this.voices.size === 0) this.disposeGraph();
  }

  private adsr(param: AudioParam, start: number, duration: number, peak: number, attack: number, sustain: number, release: number): void {
    const end = start + Math.max(0.02, duration);
    const attackEnd = start + Math.min(attack, duration * 0.2);
    const releaseStart = Math.max(attackEnd + 0.002, end - release);
    const decayEnd = Math.min(releaseStart, attackEnd + Math.min(0.12, duration * 0.3));
    param.setValueAtTime(FLOOR, start);
    param.exponentialRampToValueAtTime(Math.max(FLOOR, peak), attackEnd);
    param.exponentialRampToValueAtTime(Math.max(FLOOR, peak * sustain), decayEnd);
    param.setValueAtTime(Math.max(FLOOR, peak * sustain), releaseStart);
    param.exponentialRampToValueAtTime(FLOOR, end);
  }

  private smooth(param: AudioParam, value: number, time: number, tau: number): void {
    const when = Math.max(this.now(), Number.isFinite(time) ? time : this.now());
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(when);
    else {
      param.cancelScheduledValues(when);
      param.setValueAtTime(Number.isFinite(param.value) ? param.value : 0, when);
    }
    param.setTargetAtTime(Number.isFinite(value) ? value : 0, when, Math.max(0.003, tau));
  }

  private keep<T extends AudioNode>(node: T): T {
    this.nodes.add(node);
    return node;
  }

  private bus(level: number): GainNode {
    const gain = this.keep(this.context.createGain());
    gain.gain.value = level;
    gain.connect(this.master);
    return gain;
  }

  private filter(type: BiquadFilterType, frequency: number, q: number): BiquadFilterNode {
    const filter = this.keep(this.context.createBiquadFilter());
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    return filter;
  }

  private createPan(value: number): StereoPannerNode | GainNode {
    if (typeof this.context.createStereoPanner !== 'function') return this.context.createGain();
    const panner = this.context.createStereoPanner();
    panner.pan.value = value;
    return panner;
  }

  private pan(value: number): StereoPannerNode | GainNode {
    return this.keep(this.createPan(value));
  }

  private roomImpulse(): AudioBuffer {
    const length = Math.max(1, Math.floor(this.context.sampleRate * 0.82));
    const buffer = this.context.createBuffer(2, length, this.context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      let seed = 2917 + channel * 718;
      let low = 0;
      for (let i = 0; i < length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        low = low * 0.56 + ((seed / 0x100000000) * 2 - 1) * 0.44;
        data[i] = low * Math.exp(-i / this.context.sampleRate * 6.8) * 0.34;
      }
    }
    return buffer;
  }

  private disposeGraph(): void {
    if (this.graphDisposed) return;
    this.graphDisposed = true;
    for (const node of this.nodes) node.disconnect();
    this.nodes.clear();
  }
}
