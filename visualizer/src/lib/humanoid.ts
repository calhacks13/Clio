/** Public, manufacturer-published manipulation recordings with articulated Dex3 hands. */
export const DEFAULT_HUMANOID_DATASET =
  "unitreerobotics/G1_Dex3_BlockStacking_Dataset";
export const DEFAULT_HUMANOID_PATH = `/${DEFAULT_HUMANOID_DATASET}/episode_0?view=urdf`;
export const HUMANOID_EXAMPLES = [
  DEFAULT_HUMANOID_DATASET,
  "unitreerobotics/G1_Dex3_ToastedBread_Dataset",
  "unitreerobotics/G1_Dex3_ObjectPlacement_Dataset",
];

/** Unitree publishes both kLeftHandThumb0 and kLeftHandThumb0.q spellings. */
export function canonicalG1Joint(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.q$/, "")
    .replace(/^k(?=left|right|waist)/, "")
    .replace(/_joint$/, "")
    .replace(/_/g, "");
}
export function matchG1Joint(jointName: string, suffixes: string[]): number {
  const canonical = canonicalG1Joint(jointName);
  return suffixes.findIndex(
    (s) => /^k(left|right|waist)/i.test(s) && canonicalG1Joint(s) === canonical,
  );
}

/** Some Unitree schemas wrap all component names in a single extra array. */
export function featureComponentNames(
  value: unknown,
  width: number,
): string[] | undefined {
  if (Array.isArray(value)) {
    if (value.length === width && value.every((n) => typeof n === "string"))
      return value as string[];
    if (value.length === 1 && Array.isArray(value[0]))
      return featureComponentNames(value[0], width);
  } else if (value && typeof value === "object") {
    for (const candidate of Object.values(value)) {
      const names = featureComponentNames(candidate, width);
      if (names) return names;
    }
  }
  return undefined;
}
