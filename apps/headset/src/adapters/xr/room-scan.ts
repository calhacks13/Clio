// Before a lesson starts, make sure the headset knows the room. Quest's room setup (Space Setup)
// gives a session the floor, walls, tables and a mesh as detected planes; without one nothing is
// detected, hit-test finds nothing, and placement guesses a table 45 cm below the head. So when a
// session with plane detection still has no plane after a short wait, it asks Quest to run room
// setup (XRSession.initiateRoomCapture, Quest Browser only, once per session) and the lesson waits
// until it ends. A room scan that is already there starts the lesson at once; a failed or missing
// room setup lets it start anyway.

/** Waits this long for the saved room scan's planes before asking for a new scan. */
export const ROOM_SCAN_WAIT_MS = 1500;

type State = 'checking' | 'scanning' | 'scanned' | 'done';

export class RoomScan {
  private state: State = 'checking';
  private startedT: number | null = null;

  /** `capture`: runs room setup (roomCapture), or null when this runtime has none. */
  constructor(
    private readonly capture: (() => Promise<void>) | null,
    private readonly waitMs = ROOM_SCAN_WAIT_MS,
  ) {}

  /** The lesson may start: the room is known, or there is no way to learn it. */
  get settled(): boolean {
    return this.state === 'done' || this.state === 'scanned';
  }

  /** Call once per frame with the number of detected planes; true on the frame a scan ended. */
  update(t: number, planes: number): boolean {
    if (this.state === 'scanned') {
      this.state = 'done';
      return true;
    }
    if (this.state !== 'checking') return false;
    if (planes > 0 || !this.capture) {
      this.state = 'done';
      return false;
    }
    this.startedT ??= t;
    if (t - this.startedT < this.waitMs) return false;
    this.state = 'scanning';
    this.capture().then(
      () => {
        this.state = 'scanned';
      },
      () => {
        this.state = 'done';
      },
    );
    return false;
  }
}

/** Quest Browser's room setup for this session, or null where the browser has none. */
export function roomCapture(session: XRSession): (() => Promise<void>) | null {
  const withCapture = session as XRSession & { initiateRoomCapture?: () => Promise<void> };
  const run = withCapture.initiateRoomCapture;
  return typeof run === 'function' ? () => run.call(session) : null;
}
