import { FONT_COVERAGE, WIDGET_LIMITS } from './types';

// Text hygiene and loose matching for the coach's widgets. Everything the coach writes is cleaned
// before it is shown: only characters every bundled face has (so troika never fetches a font from
// its CDN), no emoji, and none of the symbols the headset bans; a character the fonts lack has a
// stand-in where dropping it would change a number, a unit or a comparison ("⅓ cup" reads
// "1/3 cup", not "13 cup"). Matching is forgiving about case and punctuation, so the coach can
// name a checklist item roughly and the learner can say an answer out loud; it is conservative
// about the learner's voice, where a wrong match would mark an answer they never gave.

/**
 * Symbols the headset never shows, as words or spaces. Line breaks and tabs become spaces first,
 * so dropping control characters next never joins two words.
 */
const MAPPED: readonly (readonly [RegExp, string])[] = [
  [/[\t\n\r\v\f]/g, ' '],
  [/[·•∙⋅]/g, ' '],
  [/[→⟶➜]/g, ' to '],
  [/[✓✔✗]/g, ''],
];

/**
 * Characters the fonts lack whose fallback would change what the text says, and what they read as
 * instead: dropped, "≥ 5 mm" would read "5 mm", "5 μL" "5 L" and "1‒2" "12"; decomposed, "≠"
 * would read "=" and "⅓" "13". Looked up for the character, then for each part of its
 * decomposition ("㎕" is "μl", "⅓" is "1⁄3", "≉" is "≈" struck through).
 */
const STAND_INS: Readonly<Record<string, string>> = {
  '≥': ' at least ',
  '≤': ' at most ',
  '⩾': ' at least ',
  '⩽': ' at most ',
  '≧': ' at least ',
  '≦': ' at most ',
  '≠': ' not ',
  '≈': ' about ',
  '∼': ' about ',
  '‰': ' per 1000',
  '‱': ' per 10000',
  // Greek mu and omega (the ohm sign is omega once composed).
  '\u03bc': 'µ',
  '\u03a9': 'ohm',
  '˚': '°',
  '′': "'",
  '″': '"',
  '‐': '-',
  '‒': '–',
  '―': '–',
  '⁄': '/',
  '∕': '/',
  '∶': ':',
};

/**
 * A digit keeps a space before a fraction or an ohm the fonts lack: "1⅓" reads "1 1/3", not
 * "11/3", and "220Ω" "220 ohm". ½, ¼ and ¾ are in the fonts.
 */
const SPACED = /(\d)([\u2150-\u215f\u2189\u03a9])/g;

/**
 * A run of superscripts the fonts lack reads as a power: "2⁵" is "2^5", not "25"; "m²" stays. A
 * zero before C or F is a degree: "20⁰C" is "20°C", not "20^0C".
 */
const powers = (text: string) =>
  text
    .replace(/⁰(?=[CF](?![A-Za-z]))/g, '°')
    .replace(/[\u2070-\u207f¹²³]+/g, (run) =>
      /^[¹²³]+$/.test(run) ? run : `^${run.normalize('NFKD')}`,
    );

/** The stroke through a negated comparison ("≯" is ">" and it), which the fonts lack. */
const STROKE = '\u0338';

/** Emoji, control characters and variation selectors. */
const DROPPED = /[\p{Extended_Pictographic}\p{Cc}\p{Variation_Selector}]/gu;

const covered = (char: string) => {
  const cp = char.codePointAt(0) ?? 0;
  return FONT_COVERAGE.some(([lo, hi]) => cp >= lo && cp <= hi);
};

/**
 * Keeps the characters the fonts have; one they lack is its stand-in, else what it decomposes to
 * that they have: an accented letter keeps its base letter.
 */
function keepCovered(text: string): string {
  let out = '';
  for (const char of text) {
    if (covered(char)) {
      out += char;
      continue;
    }
    const stand = STAND_INS[char];
    if (stand !== undefined) {
      out += stand;
      continue;
    }
    // "ř" becomes "r" and "ﬁ" "fi"; a character with nothing covered in it is dropped. One struck
    // through is its "not": "≯ 7" reads "not > 7" rather than "> 7".
    const parts = char.normalize('NFKD');
    if (char !== STROKE && parts.includes(STROKE)) out += ' not ';
    for (const part of parts) {
      if (covered(part)) out += part;
      else out += STAND_INS[part] ?? '';
    }
  }
  return out;
}

const letters = (word: string) => word.match(/\p{L}/gu)?.length ?? 0;

/** "CUP A IS FULL" reads "Cup A is full"; a lone all-caps word ("PH", "LED") stays. */
function unshout(text: string): string {
  if (/\p{Ll}/u.test(text)) return text;
  const words = text.split(' ');
  if (words.filter((w) => letters(w) >= 2).length < 2) return text;
  const lower = words.map((w) => (letters(w) === 1 ? w : w.toLowerCase())).join(' ');
  return lower.replace(
    /^([^\p{L}\p{N}]*)(\p{L})/u,
    (_, lead: string, first: string) => `${lead}${first.toUpperCase()}`,
  );
}

/**
 * A string argument as the widget shows it. `label` (labels, titles, items and options) also
 * loses one trailing period; questions, values and cautions keep theirs.
 */
export function cleanText(text: string, kind: 'label' | 'text' = 'text'): string {
  let out = text.normalize('NFC');
  for (const [re, to] of MAPPED) out = out.replace(re, to);
  out = powers(out).replace(SPACED, '$1 $2').replace(DROPPED, '');
  out = keepCovered(out).replace(/\s+/g, ' ').trim();
  out = unshout(out);
  return kind === 'label' ? out.replace(/(?<!\.)\.$/, '').trimEnd() : out;
}

/** The text has something to read: a letter or a digit. */
export function hasText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** For matching: lower case, no punctuation, single spaces. */
export function normalise(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\p{P}/gu, '').replace(/\s+/g, ' ').trim();
}

/** The same label, whatever its case and punctuation. */
export function sameLabel(a: string, b: string): boolean {
  return normalise(a) === normalise(b);
}

const wordsOf = (text: string) => {
  const key = normalise(text);
  return key ? key.split(' ') : [];
};

/** Where `needle` occurs as whole words in `words`. */
function occurrences(words: readonly string[], needle: readonly string[]): number[] {
  const at: number[] = [];
  if (needle.length === 0) return at;
  for (let i = 0; i + needle.length <= words.length; i++) {
    if (needle.every((w, j) => words[i + j] === w)) at.push(i);
  }
  return at;
}

/**
 * Which item the coach means by `entry`: the same text, a position ("2"), or the only item that
 * contains it or that it contains as whole words ("funnel" is "small funnel"). Null when unsure.
 */
export function matchItem(items: readonly string[], entry: string): number | null {
  const key = normalise(entry);
  if (!key) return null;
  const exact = items.findIndex((item) => normalise(item) === key);
  if (exact >= 0) return exact;
  if (/^[1-5]$/.test(key)) {
    const index = Number(key) - 1;
    return index < items.length ? index : null;
  }
  const words = key.split(' ');
  const hits: number[] = [];
  items.forEach((item, i) => {
    const own = wordsOf(item);
    if (occurrences(own, words).length > 0 || occurrences(words, own).length > 0) hits.push(i);
  });
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

const ORDINALS = ['first', 'second', 'third'];
/** Any of these before an answer means it is not the answer ("not the phillips"). */
const NEGATIONS = new Set([
  'not',
  'no',
  'dont',
  'never',
  'nor',
  'without',
  'isnt',
  'arent',
  'doesnt',
  'didnt',
  'havent',
  'hasnt',
  'cant',
  'wont',
]);

/** An ordinal names an option only as an answer: "second", "the second", "the second one". */
function ordinalAt(words: readonly string[], at: number): boolean {
  return words.length === 1 || words[at - 1] === 'the' || words[at + 1] === 'one';
}

/**
 * The option a learner's final transcript answers, by its words or an ordinal ("the second one",
 * "last"). Null unless the transcript is short (8 words at most), names exactly one option and
 * has no negation before it: a missed answer only leaves the buttons up, a wrong one would show an
 * answer they never gave.
 */
export function matchSpoken(options: readonly string[], transcript: string): number | null {
  const said = wordsOf(transcript);
  if (said.length === 0 || said.length > WIDGET_LIMITS.voiceMatchMaxWords) return null;
  const hits: { index: number; at: number }[] = [];
  options.forEach((option, index) => {
    for (const at of occurrences(said, wordsOf(option))) hits.push({ index, at });
  });
  said.forEach((word, at) => {
    const n = word === 'last' ? options.length - 1 : ORDINALS.indexOf(word);
    if (n >= 0 && n < options.length && ordinalAt(said, at)) hits.push({ index: n, at });
  });
  const first = hits[0];
  if (!first || hits.some((h) => h.index !== first.index)) return null;
  const negated = hits.some((h) => said.slice(0, h.at).some((w) => NEGATIONS.has(w)));
  return negated ? null : first.index;
}
