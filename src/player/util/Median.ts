function undefinedGlobalError(name: string): ReferenceError {
  return new ReferenceError(`${name} is not defined`);
}

/**
 * Ported from the legacy player’s Util/util (window.Median, ~line 918) — a
 * grab-bag of basic descriptive-statistics helpers used by videoPlayer's
 * `rfps` setter (mean/variance/findRangeAndCoefficient) and
 * videoTagPlayer (additionally median).
 */
export const Median = {
  max(array: number[]): number {
    return Math.max.apply(null, array);
  },

  min(array: number[]): number {
    return Math.min.apply(null, array);
  },

  // legacy references the undeclared global `arr` here (`arr.min(array)`
  // instead of `Median.min(array)`) — never actually defined anywhere in
  // util, so this throws a ReferenceError whenever called. Not used by
  // any file ported so far (grep-confirmed), but preserved for fidelity
  // since Median is ported as a complete shared utility object.
  range(array: number[]): number {
    void array;
    throw undefinedGlobalError('arr');
  },

  midrange(array: number[]): number {
    return Median.range(array) / 2;
  },

  sum(array: number[]): number {
    let num = 0;
    for (let i = 0, l = array.length; i < l; i++) num += array[i];
    return num;
  },

  mean(array: number[]): number {
    return Median.sum(array) / array.length;
  },

  median(array: number[]): number {
    const sorted = [...array].sort((a, b) => a - b);
    const mid = sorted.length / 2;
    return mid % 1 ? sorted[mid - 0.5] : (sorted[mid - 1] + sorted[mid]) / 2;
  },

  getMaxOfArray(numArray: number[]): number {
    return Math.max.apply(null, numArray);
  },

  getMinOfArray(numArray: number[]): number {
    return Math.min.apply(null, numArray);
  },

  findRangeAndCoefficient(array: number[]): number {
    const max = Median.getMaxOfArray(array);
    const min = Median.getMinOfArray(array);
    const range = max - min;
    return range / (max + min);
  },

  modes(array: number[]): number[] {
    if (!array.length) return [];
    const modeMap: Record<number, number> = {};
    let maxCount = 1;
    let modeValues = [array[0]];

    array.forEach((val) => {
      if (!modeMap[val]) modeMap[val] = 1;
      else modeMap[val]++;

      if (modeMap[val] > maxCount) {
        modeValues = [val];
        maxCount = modeMap[val];
      } else if (modeMap[val] === maxCount) {
        modeValues.push(val);
        maxCount = modeMap[val];
      }
    });
    return modeValues;
  },

  variance(array: number[]): number {
    const mean = Median.mean(array);
    return Median.mean(array.map((num) => Math.pow(num - mean, 2)));
  },

  standardDeviation(array: number[]): number {
    return Math.sqrt(Median.variance(array));
  },

  meanAbsoluteDeviation(array: number[]): number {
    const mean = Median.mean(array);
    return Median.mean(array.map((num) => Math.abs(num - mean)));
  },

  zScores(array: number[]): number[] {
    const mean = Median.mean(array);
    const standardDeviation = Median.standardDeviation(array);
    return array.map((num) => (num - mean) / standardDeviation);
  }
};
