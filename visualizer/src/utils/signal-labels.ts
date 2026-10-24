import { canonicalG1Joint } from "@/lib/humanoid";
import { CHART_CONFIG } from "./constants";

/** Classify only named joints; numeric feature indexes do not identify a body part. */
export function jointSignalCategory(series: string): string | undefined {
  const component =
    series.split(CHART_CONFIG.SERIES_NAME_DELIMITER).at(-1) ?? series;
  const joint = canonicalG1Joint(component);
  const limb = joint.match(
    /^(left|right)(shoulder|elbow|wrist|hip|knee|ankle)(pitch|roll|yaw)?$/,
  );
  if (limb) return `${capitalize(limb[1])} ${limb[2]}`;
  const finger = joint.match(
    /^(left|right)hand(thumb|index|middle|ring|pinky|little)\d+$/,
  );
  if (finger) {
    const name = finger[2] === "thumb" ? "thumb" : `${finger[2]} finger`;
    return `${capitalize(finger[1])} ${name}`;
  }
  if (/^waist(pitch|roll|yaw)$/.test(joint)) return "Waist";
  return undefined;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Preserve the source key in data and tooltips, but make named joints readable. */
export function signalDisplayName(name: string): string {
  if (!jointSignalCategory(name)) return name;
  const parts = name.split(CHART_CONFIG.SERIES_NAME_DELIMITER);
  const component = parts.pop() ?? name;
  const label = component
    .replace(/^k(?=left|right|waist)/i, "")
    .replace(/\.q$/, "")
    .replace(/_joint$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^./, (letter) => letter.toUpperCase());
  return [...parts, label].join(CHART_CONFIG.SERIES_NAME_DELIMITER);
}

export function signalChartTitle(names: string[]): string {
  return [
    ...new Set(names.map((name) => jointSignalCategory(name) ?? name)),
  ].join(", ");
}
