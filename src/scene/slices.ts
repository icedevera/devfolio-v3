// Building the stage takes a while; these give the page frames along the way.

// The next task, after whatever the page has waiting.
export const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// Gives the page a turn whenever `budget` milliseconds have passed since the
// last, so no stretch of building runs long enough to be seen.
export function slicer(budget = 6) {
  let until = performance.now() + budget;
  return async () => {
    if (performance.now() < until) return;
    await pause();
    until = performance.now() + budget;
  };
}
