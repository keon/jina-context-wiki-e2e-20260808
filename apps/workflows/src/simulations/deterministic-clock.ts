/** Monotonic ISO timestamps for reproducible simulation output. */
export function deterministicClock(): () => string {
  let tick = 0;
  return () => {
    const minutes = String(Math.floor(tick / 60)).padStart(2, "0");
    const seconds = String(tick % 60).padStart(2, "0");
    tick += 1;
    return `2026-07-08T00:${minutes}:${seconds}.000Z`;
  };
}
