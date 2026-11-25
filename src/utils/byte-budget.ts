export const READ_GRAPH_BYTE_BUDGET = 100_000;

export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** Longest prefix of `items` whose JSON size fits `budget`; always keeps one item so paging makes progress. */
export function takeWithinBudget<T>(items: T[], budget: number, extraBytes: (item: T, index: number) => number = () => 0): T[] {
  let used = 2;
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    used += jsonBytes(items[i]) + 1 + extraBytes(items[i], i);
    if (used > budget && count > 0) break;
    count++;
  }
  return items.slice(0, count);
}
