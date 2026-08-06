const marksEnabled = import.meta.env.DEV || window.localStorage.getItem("muzare:performance") === "1";

export const markEntryPerformance = (name: string) => {
  if (!marksEnabled || typeof performance === "undefined") return;
  performance.mark(`muzare:${name}`);
};

export const measureEntryPerformance = (name: string, startMark: string, endMark: string) => {
  if (!marksEnabled || typeof performance === "undefined") return;
  const start = `muzare:${startMark}`;
  const end = `muzare:${endMark}`;
  if (!performance.getEntriesByName(start).length || !performance.getEntriesByName(end).length) return;
  performance.measure(`muzare:${name}`, start, end);

  const measurement = performance.getEntriesByName(`muzare:${name}`).at(-1);
  if (measurement) {
    console.debug(`[Muzare performance] ${name}: ${measurement.duration.toFixed(1)}ms`);
  }
};

export const waitForElement = <T extends Element>(
  selector: string,
  options: { root?: ParentNode; maxFrames?: number } = {},
): Promise<T | null> => {
  const root = options.root ?? document;
  const maxFrames = options.maxFrames ?? 120;

  return new Promise((resolve) => {
    let frame = 0;
    const inspect = () => {
      const element = root.querySelector<T>(selector);
      if (element || frame >= maxFrames) {
        resolve(element ?? null);
        return;
      }
      frame += 1;
      requestAnimationFrame(inspect);
    };
    inspect();
  });
};
