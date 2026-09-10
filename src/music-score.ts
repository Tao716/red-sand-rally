/**
 * Original score for Dustline. Written for this game, not an imitation or an
 * arrangement of an existing recording. One step is a sixteenth note.
 */
export const SCORE_BARS = 32;
export const STEPS_PER_BAR = 16;

export interface ScoreNote {
  step: number;
  midi: number;
  length: number;
  velocity: number;
}

export interface ScoreChord {
  name: string;
  root: number;
  notes: readonly number[];
}

const CHORDS: readonly ScoreChord[] = [
  { name: 'Dm9', root: 38, notes: [50, 53, 57, 60, 64] },
  { name: 'B♭maj9', root: 34, notes: [46, 50, 53, 57, 60] },
  { name: 'Fadd9', root: 41, notes: [48, 53, 57, 60, 67] },
  { name: 'Cadd9', root: 36, notes: [48, 52, 55, 60, 62] },
];

const n = (step: number, midi: number, length: number, velocity = 0.76): ScoreNote => ({ step, midi, length, velocity });

// The opening D–A–C–D / F–E–D figure is the recurring Dustline hook.
const THEME_A: readonly (readonly ScoreNote[])[] = [
  [n(0,74,2), n(3,69,1), n(4,72,2), n(6,74,2), n(10,77,2), n(13,76,1), n(14,74,2)],
  [n(0,69,3), n(4,72,2), n(6,74,3), n(10,76,1), n(12,77,2), n(14,76,2)],
  [n(0,77,2), n(3,74,1), n(4,72,3), n(8,69,2), n(11,65,1), n(12,69,4)],
  [n(2,72,2), n(4,74,2), n(7,77,3), n(12,74,2), n(14,72,2)],
  [n(0,69,2), n(3,72,1), n(4,77,3), n(8,79,2), n(11,77,1), n(12,76,2), n(14,72,2)],
  [n(0,69,3), n(4,72,2), n(6,74,3), n(10,72,2), n(12,69,4)],
  [n(0,67,2), n(3,72,1), n(4,74,3), n(8,76,2), n(11,74,1), n(12,72,4)],
  [n(0,67,3), n(4,70,2), n(6,69,2), n(10,67,2), n(12,76,2), n(14,72,2)],
];

const THEME_B: readonly (readonly ScoreNote[])[] = [
  [n(0,74,3), n(4,77,2), n(6,81,3), n(10,79,2), n(12,77,2), n(14,76,2)],
  [n(0,74,2), n(3,72,1), n(4,74,4), n(10,69,2), n(12,72,2), n(14,74,2)],
  [n(0,74,3), n(4,77,2), n(7,81,3), n(11,79,1), n(12,77,4)],
  [n(2,74,2), n(4,72,2), n(6,69,3), n(10,72,2), n(12,74,4)],
  [n(0,72,2), n(3,77,1), n(4,81,3), n(8,79,2), n(10,77,2), n(12,72,4)],
  [n(0,74,2), n(3,72,1), n(4,69,3), n(8,72,2), n(10,77,2), n(12,76,2), n(14,72,2)],
  [n(0,67,2), n(3,72,1), n(4,76,3), n(8,79,2), n(11,76,1), n(12,74,4)],
  [n(0,72,3), n(4,74,2), n(6,76,2), n(10,79,2), n(12,76,2), n(14,72,2)],
];

const normalBar = (bar: number): number => ((Math.floor(Number.isFinite(bar) ? bar : 0) % SCORE_BARS) + SCORE_BARS) % SCORE_BARS;

export function chordAtBar(bar: number): ScoreChord {
  return CHORDS[Math.floor(normalBar(bar) / 2) % CHORDS.length];
}

/** Four eight-bar sections: hook, open-sky answer, low-register break, return. */
export function leadForBar(bar: number): readonly ScoreNote[] {
  const position = normalBar(bar);
  const phrase = position % 8;
  if (position < 8) return THEME_A[phrase];
  if (position < 16) return THEME_B[phrase];
  if (position < 24) {
    const source = THEME_A[phrase];
    return [source[0], source[Math.floor(source.length / 2)], source[source.length - 1]]
      .map((note, index) => n(index * 6, note.midi - 12, 3.8, 0.65));
  }
  return (phrase % 2 === 0 ? THEME_B[phrase] : THEME_A[phrase])
    .map(note => ({ ...note, velocity: 0.84 }));
}

export function menuForBar(bar: number): readonly ScoreNote[] {
  const source = THEME_A[normalBar(bar) % 8];
  return [n(0, source[0].midi - 12, 4.8, 0.52), n(10, source[source.length - 1].midi - 12, 4, 0.45)];
}

export function bassForBar(bar: number): readonly ScoreNote[] {
  const { root } = chordAtBar(bar);
  if (normalBar(bar) >= 16 && normalBar(bar) < 24) {
    return [n(0, root, 3.3, 0.9), n(6, root + 7, 1.5, 0.62), n(8, root, 3.3, 0.86), n(14, root + 12, 1.2, 0.58)];
  }
  return [
    n(0,root,1.7,0.95), n(3,root+12,0.7,0.6), n(4,root,1.5,0.82), n(6,root+7,1.35,0.7),
    n(8,root,1.7,0.9), n(11,root+12,0.7,0.58), n(12,root,1.5,0.8), n(14,root+7,1.4,0.7),
  ];
}

export function arpMidiAt(bar: number, step: number): number {
  const notes = chordAtBar(bar).notes;
  const pattern = [0, 2, 1, 3, 2, 4, 3, 1];
  const midi = notes[pattern[((step % 8) + 8) % 8]];
  return midi + (midi < 60 ? 24 : 12);
}

export const midiFrequency = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
