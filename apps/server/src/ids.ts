// Identifiers that end up in file paths. Every path parameter goes through `isSafeId` (or
// `isSafeMediaName`) before it touches the filesystem, so "..", slashes and dotfiles never resolve.

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_MEDIA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSafeId(s: string): boolean {
  return SAFE_ID.test(s);
}

export function isSafeMediaName(s: string): boolean {
  return SAFE_MEDIA_NAME.test(s);
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `ep-YYYYMMDD-HHMMSS-xxxx` in UTC: sorts by creation time, 4 random base36 chars. */
export function newEpisodeId(now: Date, rand: () => number = Math.random): string {
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    const digit = Math.min(35, Math.max(0, Math.floor(rand() * 36)));
    suffix += digit.toString(36);
  }
  return `ep-${date}-${time}-${suffix}`;
}
