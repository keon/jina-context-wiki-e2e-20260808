/**
 * Return the average latency for a batch of completed requests.
 *
 * @param {number[]} samples latency measurements in milliseconds
 * @returns {number} the arithmetic mean
 */
export function averageLatency(samples) {
  return samples.reduce((total, sample) => total + sample, 0) / samples.length;
}
