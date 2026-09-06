/**
 * scripts/harness/aqi/cycle-detector.mjs
 * Deterministic cycle detection using Tarjan's Strongly Connected Components (SCC).
 */

/**
 * Deterministic Tarjan's Strongly Connected Components (SCC) algorithm.
 * Identifies dependency cycles in a directed graph.
 *
 * @param {Map<string, Set<string>>} graph
 * @returns {Array<string[]>} List of SCCs with size > 1
 */
export function findDependencyCycles(graph) {
  let index = 0;
  const indices = new Map();
  const lowlinks = new Map();
  const onStack = new Map();
  const stack = [];
  const cycles = [];

  const nodes = Array.from(graph.keys()).sort();

  function strongConnect(v) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.set(v, true);

    const neighbors = Array.from(graph.get(v) || []).sort();
    for (const w of neighbors) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v), lowlinks.get(w)));
      } else if (onStack.get(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.set(w, false);
        component.push(w);
      } while (w !== v);

      if (component.length > 1) {
        cycles.push(component.sort());
      }
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }

  return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}
