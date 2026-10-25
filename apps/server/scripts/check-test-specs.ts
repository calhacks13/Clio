import type { BenchCheckExpect, StepCheckObject, StepCheckRequest } from '@clio/protocol';

// The step watcher's hard cases, as data: the scenes an image model paints and the watcher tests
// made from them (scripts/check-tests.ts writes both). Each scene is a first-person headset view;
// a later one is painted from an earlier one, so the "before" and "now" of a test show the same
// table. A few are made by hand from another (darkened and blurred, or cropped as if the learner
// looked away), so their label doesn't depend on the image model.

export interface SceneSpec {
  /** File name in the cache, without the extension. */
  name: string;
  /** Painted from this scene (an edit), or from the prompt alone. */
  from?: string;
  prompt?: string;
  /** Made from `from` with this ffmpeg filter instead of the image model. */
  filter?: string;
}

export interface CheckTestSpec {
  title: string;
  expect: BenchCheckExpect;
  goal: string;
  step: StepCheckRequest['step'];
  objects?: StepCheckObject[];
  confusions?: string[];
  /** Scene names. */
  before: string;
  now: string;
  /** What the "now" view shows, for whoever reads the test. */
  notes: string;
}

const VIEW =
  'A photorealistic photo from the point of view of a person wearing a mixed-reality headset, ' +
  'seated and looking slightly down at what is in front of them: a first-person view like a ' +
  'head-mounted camera, slight wide-angle lens, natural indoor light, a little sensor noise. ' +
  'Landscape 4:3. No text overlays, no watermark.';
const KEEP =
  'Keep everything else exactly as it is: the same camera position and angle, the same objects ' +
  'in the same places, the same light.';
const HAND =
  "the learner's own right hand, seen from their point of view, reaching in from the bottom " +
  'right edge of the view';
/** The image model sometimes paints the headset's own visor into the view. */
const NO_HEADSET =
  'The headset itself is not in view: no visor, frame, glasses or reflection of the person.';

export const SCENES: SceneSpec[] = [
  {
    name: 'ph-start',
    prompt:
      `${VIEW} On a light wooden kitchen table, near the front, three identical clear plastic ` +
      'cups stand in a row from left to right, each with a strip of white tape on its front ' +
      'showing a large black hand-written letter: A (left), B (middle), C (right). Each cup is ' +
      'about a third full of deep purple red-cabbage indicator. Behind and to the right of the ' +
      "cups: a white squeeze bottle with a red cap and a printed label 'VINEGAR', a white " +
      "squeeze bottle with a blue cap and a printed label 'BASE', and a small open-topped glass " +
      "jar of the same deep purple liquid labeled 'INDICATOR'. An empty clear plastic 10 mL " +
      'syringe lies flat on the table in front of the bottles. No hands or people in view.',
  },
  {
    name: 'ph-empty',
    from: 'ph-start',
    prompt: `Edit this photo: all three cups A, B and C are now empty, clean and dry. ${KEEP} No hands.`,
  },
  {
    name: 'ph-two-filled',
    from: 'ph-empty',
    prompt:
      'Edit this photo: cups A and B now each hold about a third of deep purple liquid, the ' +
      `same purple as the INDICATOR jar. Cup C stays completely empty and dry. ${KEEP} No hands.`,
  },
  {
    name: 'ph-a-pink',
    from: 'ph-start',
    prompt:
      "Edit this photo: cup A's liquid is now bright pink instead of purple (vinegar was added " +
      `to it). Cups B and C stay the same deep purple. ${KEEP} No hands.`,
  },
  {
    name: 'ph-b-pink',
    from: 'ph-start',
    prompt:
      "Edit this photo: cup B's liquid (the middle cup) is now bright pink instead of purple. " +
      `Cups A and C stay the same deep purple. ${KEEP} No hands.`,
  },
  {
    name: 'ph-vinegar-in-hand',
    from: 'ph-start',
    prompt:
      `Edit this photo: add ${HAND}, holding the white VINEGAR bottle with the red cap a few ` +
      'centimetres above the table, to the right of the cups, not over any cup yet. All three ' +
      `cups stay deep purple. ${KEEP}`,
  },
  {
    name: 'ph-a-hidden',
    from: 'ph-a-pink',
    prompt:
      "Edit this photo: add the learner's own right hand, seen from their point of view, " +
      'reaching in from the bottom edge of the view, held flat and upright directly in front of ' +
      'cup A, so close to the camera that the hand completely hides cup A: none of cup A or its ' +
      `liquid is visible. Cups B and C stay deep purple and fully visible. ${KEEP}`,
  },
  {
    name: 'ph-a-out-of-view',
    from: 'ph-a-pink',
    // As if the learner turned their head to the right: cups A and B leave the view.
    filter: 'crop=iw*0.5:ih*0.5:iw*0.5:ih*0.3',
  },
  {
    name: 'ph-a-dark-blurred',
    from: 'ph-a-pink',
    // The head turning fast in a dim room: smeared sideways, dark and washed out.
    filter: 'dblur=angle=0:radius=60,eq=brightness=-0.32:contrast=0.45:saturation=0.25',
  },
  {
    name: 'ph-b-teal',
    from: 'ph-a-pink',
    prompt:
      "Edit this photo: cup B's liquid (the middle cup) is now blue-green (teal) instead of " +
      `purple. Cup A stays bright pink and cup C stays deep purple. ${KEEP} No hands.`,
  },
  {
    name: 'ph-b-and-c-teal',
    from: 'ph-b-teal',
    prompt:
      "Edit this photo: cup C's liquid (the right cup) is now the same blue-green (teal) as " +
      `cup B. Cup A stays bright pink. ${KEEP} No hands.`,
  },
  {
    name: 'ph-c-teal',
    from: 'ph-a-pink',
    prompt:
      "Edit this photo: cup C's liquid (the right cup) is now blue-green (teal) instead of " +
      `purple. Cup A stays bright pink and cup B stays deep purple. ${KEEP} No hands.`,
  },
  {
    name: 'ph-syringe-clear',
    from: 'ph-start',
    prompt:
      `Edit this photo: add ${HAND}, holding the syringe up over the bare table in the lower ` +
      'middle of the view, with only wood behind it, not in front of any cup or bottle. The ' +
      "syringe's barrel is now filled with about 5 mL of perfectly clear, colorless liquid, with no " +
      "purple in it at all. The VINEGAR bottle's red cap is off and lies on the table beside " +
      `the bottle. ${KEEP}`,
  },
  {
    name: 'ph-syringe-purple',
    from: 'ph-start',
    prompt:
      `Edit this photo: add ${HAND}, holding the syringe up over the bare table in the lower ` +
      'middle of the view, with only wood behind it, not in front of any cup or bottle. The ' +
      "syringe's barrel is now filled with about 5 mL of deep purple liquid, the same purple as the " +
      `INDICATOR jar. ${KEEP}`,
  },
  {
    name: 'ph-base-open',
    from: 'ph-start',
    prompt:
      "Edit this photo: the BASE bottle's blue cap has been unscrewed and lies on its side on " +
      "the table next to the bottle, so the BASE bottle's open nozzle shows. The VINEGAR bottle " +
      `still has its red cap on. ${KEEP} No hands.`,
  },
  {
    name: 'ph-vinegar-open',
    from: 'ph-start',
    prompt:
      "Edit this photo: the VINEGAR bottle's red cap has been unscrewed and lies on its side on " +
      "the table next to the bottle, so the VINEGAR bottle's open nozzle shows. The BASE bottle " +
      `still has its blue cap on. ${KEEP} No hands.`,
  },
  {
    name: 'fridge-start',
    prompt:
      `${VIEW} The person stands in front of an open refrigerator, looking into it at chest ` +
      'height. On the middle shelf, side by side and touching, stand a small white plastic ' +
      "bottle with a pink cap and a label 'YOGURT DRINK', and a slightly taller white plastic " +
      "bottle with a blue cap and a label 'MILK'. Other groceries on the other shelves: eggs, " +
      'a jar of jam, butter, vegetables in the crisper drawer. The fridge door is open on the ' +
      `right. No hands or people in view. ${NO_HEADSET}`,
  },
  {
    name: 'fridge-yogurt-in-hand',
    from: 'fridge-start',
    prompt:
      `Edit this photo: add ${HAND}, holding the small white YOGURT DRINK bottle with the pink ` +
      "cap, lifted out of the fridge in front of the shelf. The yogurt drink's place on the " +
      'middle shelf is now empty, and the taller MILK bottle with the blue cap still stands on ' +
      `the shelf. ${KEEP}`,
  },
  {
    name: 'fridge-milk-in-hand',
    from: 'fridge-start',
    prompt:
      `Edit this photo: add ${HAND}, holding the taller white MILK bottle with the blue cap, ` +
      "lifted out of the fridge in front of the shelf. The milk's place on the middle shelf is " +
      'now empty, and the small YOGURT DRINK bottle with the pink cap still stands on the ' +
      `shelf. ${KEEP}`,
  },
  {
    name: 'fridge-yogurt-grasped',
    from: 'fridge-start',
    prompt:
      `Edit this photo: add ${HAND}, its fingers wrapped around the small YOGURT DRINK bottle ` +
      'with the pink cap while the bottle still stands on the middle shelf beside the milk: it ' +
      `has not been lifted yet. ${KEEP}`,
  },
  {
    name: 'desk-start',
    prompt:
      `${VIEW} On a wooden desk in front of the person: a round cork coaster near the front ` +
      'centre, empty; to the left of it a blue ceramic coffee mug, and to the right of it a ' +
      'grey ceramic coffee mug of exactly the same shape and size. A closed laptop and a ' +
      `notebook lie further back. No hands or people in view. ${NO_HEADSET}`,
  },
  {
    name: 'desk-blue-on-coaster',
    from: 'desk-start',
    prompt:
      'Edit this photo: the blue mug now stands on the cork coaster. The grey mug stays where ' +
      `it was. ${KEEP} No hands.`,
  },
  {
    name: 'desk-grey-on-coaster',
    from: 'desk-start',
    prompt:
      'Edit this photo: the grey mug now stands on the cork coaster. The blue mug stays where ' +
      `it was. ${KEEP} No hands.`,
  },
  {
    name: 'desk-blue-lifted',
    from: 'desk-start',
    prompt:
      `Edit this photo: add ${HAND}, holding the blue mug by its handle high in the air, about ` +
      'twenty centimetres above the table and to the right of the coaster, with a clear gap ' +
      'between the mug and the table. The cork coaster is still completely empty, and the grey ' +
      `mug stays where it was. ${KEEP}`,
  },
  // The harder batch: no labels, mid-action, a step back, readable but poor frames, and
  // done-whens that need the start of the step to judge.
  {
    name: 'ph-plain-start',
    from: 'ph-start',
    prompt:
      'Edit this photo: remove the white tape labels from the three cups, so they are three ' +
      `identical plain clear cups with no letters or marks, each still a third full of deep purple. ${KEEP} No hands.`,
  },
  {
    name: 'ph-plain-left-pink',
    from: 'ph-plain-start',
    prompt:
      "Edit this photo: the leftmost cup's liquid is now bright pink instead of purple. The " +
      `middle and right cups stay the same deep purple. ${KEEP} No hands.`,
  },
  {
    name: 'ph-plain-middle-pink',
    from: 'ph-plain-start',
    prompt:
      "Edit this photo: the middle cup's liquid is now bright pink instead of purple. The " +
      `left and right cups stay the same deep purple. ${KEEP} No hands.`,
  },
  {
    name: 'ph-mid-pour',
    from: 'ph-start',
    prompt:
      `Edit this photo: add ${HAND}, holding the white VINEGAR bottle with the red cap tilted ` +
      'over cup A, with a thin stream of clear liquid pouring into cup A. Where the stream ' +
      "enters, cup A's purple liquid is just starting to change: a small pink swirl at the " +
      `surface, most of it still deep purple. Cups B and C stay deep purple. ${KEEP}`,
  },
  {
    name: 'ph-a-pink-hand-near',
    from: 'ph-a-pink',
    prompt:
      `Edit this photo: add ${HAND}, holding the empty syringe upright just to the right of ` +
      "cup A, covering only cup A's right edge: most of cup A, its tape label and its bright " +
      `pink liquid stay clearly visible. Cups B and C stay deep purple. ${KEEP}`,
  },
  {
    name: 'ph-a-pink-dim',
    from: 'ph-a-pink',
    // An evening kitchen and a slightly shaky head: darker, softer and noisy, but readable.
    filter: 'eq=brightness=-0.12:saturation=0.85,gblur=sigma=1.6,noise=alls=14:allf=t',
  },
  {
    name: 'ph-far-a-pink',
    from: 'ph-a-pink',
    prompt:
      'Edit this photo: the person has stepped back from the table. Show the same table and ' +
      'the same objects from about two metres away and a little higher, so the whole table is ' +
      'small in the middle of the view, with more of the kitchen around it. Cup A is still ' +
      'pink and cups B and C are still deep purple. No hands.',
  },
  {
    name: 'ph-far-b-teal',
    from: 'ph-far-a-pink',
    prompt:
      "Edit this photo: cup B's liquid (the middle cup) is now blue-green (teal) instead of " +
      `purple. Cup A stays pink and cup C stays deep purple. ${KEEP} No hands.`,
  },
  {
    name: 'ph-far-c-teal',
    from: 'ph-far-a-pink',
    prompt:
      "Edit this photo: cup C's liquid (the right cup) is now blue-green (teal) instead of " +
      `purple. Cup A stays pink and cup B stays deep purple. ${KEEP} No hands.`,
  },
  {
    name: 'plant-start',
    prompt:
      `${VIEW} On a windowsill in front of the person: a small basil plant in a terracotta pot. ` +
      'The soil in the pot is dry, pale light brown and slightly cracked. A green plastic ' +
      `watering can stands beside the pot. No hands or people in view. ${NO_HEADSET}`,
  },
  {
    name: 'plant-watered',
    from: 'plant-start',
    prompt:
      'Edit this photo: the soil in the pot has just been watered: it is now dark brown, wet ' +
      `and glistening all over. The watering can stays where it is. ${KEEP} No hands.`,
  },
  {
    name: 'plant-can-lifted',
    from: 'plant-start',
    prompt:
      `Edit this photo: add ${HAND}, lifting the green watering can and tilting it towards the ` +
      'pot, but no water is coming out yet: the soil stays dry and pale light brown. ' +
      KEEP,
  },
];

const PH_GOAL = 'Test an acid and a base with red-cabbage indicator';
const CUP = (letter: string, where: string): StepCheckObject => ({
  id: `cup_${letter.toLowerCase()}`,
  label: `cup ${letter}`,
  look: `clear plastic cup with white tape marked ${letter}, the ${where} of the three`,
});
const VINEGAR: StepCheckObject = {
  id: 'vinegar',
  label: 'vinegar bottle',
  look: "white squeeze bottle with a red cap, labeled 'VINEGAR'",
};
const BASE: StepCheckObject = {
  id: 'base',
  label: 'base bottle',
  look: "white squeeze bottle with a blue cap, labeled 'BASE'",
};
const INDICATOR: StepCheckObject = {
  id: 'indicator',
  label: 'indicator jar',
  look: "small glass jar of deep purple liquid, labeled 'INDICATOR'",
};
const SYRINGE: StepCheckObject = {
  id: 'syringe',
  label: 'syringe',
  look: 'clear plastic 10 mL syringe',
};

const ACID_STEP = {
  id: 'acid-to-a',
  instruction: 'Add a little vinegar to cup A.',
  doneWhen: "Cup A's indicator has turned pink.",
};
const ACID = { goal: PH_GOAL, step: ACID_STEP, objects: [CUP('A', 'left one'), VINEGAR] };
const BASE_STEP = {
  goal: PH_GOAL,
  step: {
    id: 'base-to-b',
    instruction: 'Add a little base to cup B, and leave cup C as it is.',
    doneWhen: 'Cup B has turned blue-green while cup C stays purple.',
  },
  objects: [CUP('B', 'middle one'), CUP('C', 'right one'), BASE],
  confusions: ['Base went into cup C too: cup C is the purple control and gets nothing.'],
};
const FILL_STEP = {
  goal: PH_GOAL,
  step: {
    id: 'fill-cups',
    instruction: 'Pour a little indicator into cups A, B and C.',
    doneWhen: 'All three cups hold purple indicator.',
  },
  objects: [CUP('A', 'left one'), CUP('B', 'middle one'), CUP('C', 'right one'), INDICATOR],
};
const DRAW_STEP = {
  goal: PH_GOAL,
  step: {
    id: 'draw-indicator',
    instruction: 'Draw about 5 mL of indicator into the syringe.',
    doneWhen: 'The syringe holds purple indicator.',
  },
  objects: [SYRINGE, INDICATOR],
  confusions: ['That is vinegar, which is clear. Draw the purple indicator from the jar.'],
};
const OPEN_BASE = {
  goal: PH_GOAL,
  step: {
    id: 'open-base',
    instruction: 'Unscrew the blue cap of the base bottle.',
    doneWhen: 'The base bottle is open, its blue cap off.',
  },
  objects: [BASE],
};
const FRIDGE = {
  goal: 'Get a yogurt drink from the fridge',
  step: {
    id: 'take-yogurt',
    instruction: 'Take the yogurt drink out of the fridge.',
    doneWhen: "The yogurt drink is in the learner's hand, lifted off the shelf.",
  },
  objects: [
    {
      id: 'yogurt_drink',
      label: 'yogurt drink',
      look: "small white plastic bottle with a pink cap, labeled 'YOGURT DRINK'",
    },
  ],
  confusions: ['That is the milk (taller, blue cap). Take the small bottle with the pink cap.'],
};
const MUG = {
  goal: 'Set the desk up for a video call',
  step: {
    id: 'mug-on-coaster',
    instruction: 'Put the blue mug on the coaster.',
    doneWhen: 'The blue mug stands on the cork coaster.',
  },
  objects: [
    { id: 'blue_mug', label: 'blue mug', look: 'blue ceramic coffee mug' },
    { id: 'coaster', label: 'coaster', look: 'round cork coaster' },
  ],
};

const PLAIN = {
  goal: PH_GOAL,
  step: {
    id: 'acid-to-left',
    instruction: 'Add a little vinegar to the cup on the left.',
    doneWhen: "The left cup's indicator has turned pink.",
  },
  objects: [
    { id: 'left_cup', label: 'left cup', look: 'the leftmost of three identical clear cups' },
    VINEGAR,
  ],
};
const PLANT = {
  goal: 'Water the basil',
  step: {
    id: 'water',
    instruction: 'Water the basil plant.',
    doneWhen: 'The soil in the pot is dark and wet all over.',
  },
  objects: [{ id: 'basil', label: 'basil pot', look: 'small terracotta pot with a basil plant' }],
};

export const CHECK_TESTS: CheckTestSpec[] = [
  {
    ...ACID,
    title: 'Vinegar in cup A, cup A pink',
    expect: 'done',
    before: 'ph-start',
    now: 'ph-a-pink',
    notes: 'Cup A pink, cups B and C purple. No hands.',
  },
  {
    ...ACID,
    title: 'Vinegar bottle in hand, cups still purple',
    expect: 'not_done',
    before: 'ph-start',
    now: 'ph-vinegar-in-hand',
    notes: 'The hand holds the vinegar bottle above the table; every cup still purple.',
  },
  {
    ...ACID,
    title: 'Vinegar went into cup B, not cup A',
    expect: 'wrong',
    before: 'ph-start',
    now: 'ph-b-pink',
    notes: 'Cup B pink, cups A and C purple. No mix-up listed: the model must notice the cup.',
  },
  {
    ...ACID,
    title: 'Cup A hidden behind the hand',
    expect: 'unsure',
    before: 'ph-start',
    now: 'ph-a-hidden',
    notes: 'Cup A is pink but a hand hides it completely. Nothing in view says done or not.',
  },
  {
    ...ACID,
    title: 'Cup A out of view',
    expect: 'unsure',
    before: 'ph-start',
    now: 'ph-a-out-of-view',
    notes: 'Cropped from the done view as if the learner looked right: cups A and B are gone.',
  },
  {
    ...ACID,
    title: 'Dark, blurred view of the cups',
    expect: 'unsure',
    before: 'ph-start',
    now: 'ph-a-dark-blurred',
    notes: 'The done view, darkened and smeared sideways by ffmpeg: no cup can be read.',
  },
  {
    ...BASE_STEP,
    title: 'Cup B blue-green, control cup C still purple',
    expect: 'done',
    before: 'ph-a-pink',
    now: 'ph-b-teal',
    notes: 'A pink, B blue-green, C purple: the comparison holds.',
  },
  {
    ...BASE_STEP,
    title: 'Base in cup B and the control cup C',
    expect: 'wrong',
    before: 'ph-a-pink',
    now: 'ph-b-and-c-teal',
    notes: 'A pink, B and C both blue-green: the control is spoiled. Listed as a mistake.',
  },
  {
    ...BASE_STEP,
    title: 'Base went into cup C, not cup B',
    expect: 'wrong',
    before: 'ph-a-pink',
    now: 'ph-c-teal',
    notes: 'A pink, B purple, C blue-green.',
  },
  {
    ...FILL_STEP,
    title: 'Indicator in cups A and B, cup C still empty',
    expect: 'not_done',
    before: 'ph-empty',
    now: 'ph-two-filled',
    notes: 'Partly done: two of three cups hold indicator.',
  },
  {
    ...FILL_STEP,
    title: 'Indicator in all three cups',
    expect: 'done',
    before: 'ph-empty',
    now: 'ph-start',
    notes: 'The empty cups, then all three a third full of purple.',
  },
  {
    ...DRAW_STEP,
    title: 'Syringe drew clear vinegar, not indicator',
    expect: 'not_done',
    before: 'ph-start',
    now: 'ph-syringe-clear',
    notes:
      'The plunger is drawn back and the vinegar is open, but the barrel is clear, not purple: ' +
      'the listed mistake. Saying what went wrong is right too; done is the failure.',
  },
  {
    ...DRAW_STEP,
    title: 'Syringe holds purple indicator',
    expect: 'done',
    before: 'ph-start',
    now: 'ph-syringe-purple',
    notes: 'The hand holds the syringe full of purple liquid.',
  },
  {
    ...OPEN_BASE,
    title: 'Blue cap off the base bottle',
    expect: 'done',
    before: 'ph-start',
    now: 'ph-base-open',
    notes: 'The blue cap lies beside the open base bottle; the vinegar is still capped.',
  },
  {
    ...OPEN_BASE,
    title: 'Red cap off the vinegar, base still closed',
    expect: 'wrong',
    before: 'ph-start',
    now: 'ph-vinegar-open',
    notes: 'The look-alike bottle was opened. No mix-up listed.',
  },
  {
    ...FRIDGE,
    title: 'Yogurt drink in hand',
    expect: 'done',
    before: 'fridge-start',
    now: 'fridge-yogurt-in-hand',
    notes: 'The pink-capped bottle is in hand, off the shelf; the milk stays on the shelf.',
  },
  {
    ...FRIDGE,
    title: 'Milk taken for the yogurt drink',
    expect: 'wrong',
    before: 'fridge-start',
    now: 'fridge-milk-in-hand',
    notes: 'The taller blue-capped milk is in hand; the yogurt drink stays on the shelf.',
  },
  {
    ...FRIDGE,
    title: 'Yogurt drink grasped, still on the shelf',
    expect: 'not_done',
    before: 'fridge-start',
    now: 'fridge-yogurt-grasped',
    notes: 'Partly done: the hand holds the right bottle, but it has not left the shelf.',
  },
  {
    ...MUG,
    title: 'Blue mug on the coaster',
    expect: 'done',
    before: 'desk-start',
    now: 'desk-blue-on-coaster',
    notes: 'The blue mug stands on the coaster; the grey one where it was.',
  },
  {
    ...MUG,
    title: 'Grey mug on the coaster, not the blue one',
    expect: 'wrong',
    before: 'desk-start',
    now: 'desk-grey-on-coaster',
    notes: 'The look-alike mug is on the coaster. No mix-up listed.',
  },
  {
    ...MUG,
    title: 'Blue mug lifted, not set down yet',
    expect: 'not_done',
    before: 'desk-start',
    now: 'desk-blue-lifted',
    notes: 'Partly done: the blue mug is in hand above the table; the coaster is empty.',
  },
  {
    ...PLAIN,
    title: 'Plain cups, vinegar in the left one',
    expect: 'done',
    before: 'ph-plain-start',
    now: 'ph-plain-left-pink',
    notes: 'No labels: only its place tells the left cup. The left cup is pink.',
  },
  {
    ...PLAIN,
    title: 'Plain cups, vinegar in the middle one',
    expect: 'wrong',
    before: 'ph-plain-start',
    now: 'ph-plain-middle-pink',
    notes: 'No labels: the middle cup turned pink, the left one is still purple.',
  },
  {
    ...ACID,
    title: 'Vinegar pouring, cup A only starting to change',
    expect: 'not_done',
    before: 'ph-start',
    now: 'ph-mid-pour',
    notes: 'Mid-action: the stream is going in and a pink swirl shows, but cup A is still purple.',
  },
  {
    ...ACID,
    title: 'Cup A pink with a hand beside it',
    expect: 'done',
    before: 'ph-start',
    now: 'ph-a-pink-hand-near',
    notes: 'A hand covers only the edge of cup A; its pink is plain to see. Unsure is too careful.',
  },
  {
    ...ACID,
    title: 'Cup A pink in a dim, soft frame',
    expect: 'done',
    before: 'ph-start',
    now: 'ph-a-pink-dim',
    notes: 'The done view, darker, softer and noisy (ffmpeg), but cup A is still plainly pink.',
  },
  {
    ...BASE_STEP,
    title: 'Stepped back, cup B blue-green, cup C purple',
    expect: 'done',
    before: 'ph-a-pink',
    now: 'ph-far-b-teal',
    notes: 'The start was close up; now the table is small and far. The comparison holds.',
  },
  {
    ...BASE_STEP,
    title: 'Stepped back, base went into cup C',
    expect: 'wrong',
    before: 'ph-a-pink',
    now: 'ph-far-c-teal',
    notes: 'Small and far: cup C is blue-green, cup B still purple.',
  },
  {
    ...PLANT,
    title: 'Basil soil dark and wet',
    expect: 'done',
    before: 'plant-start',
    now: 'plant-watered',
    notes: 'Only the soil changed: pale and dry at the start, dark and wet now.',
  },
  {
    ...PLANT,
    title: 'Watering can tilted, soil still dry',
    expect: 'not_done',
    before: 'plant-start',
    now: 'plant-can-lifted',
    notes: 'The motion is there but no water yet: the soil is as pale as at the start.',
  },
];
