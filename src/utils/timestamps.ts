const ISO_DATE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?: ?(Z|[+-]\d{2}:?\d{2}))?)?$/;

export function parseIsoDate(value: string): number {
  const match = ISO_DATE.exec(value.trim());
  if (!match) return NaN;
  const [, day, time, zone] = match;
  const midnight = new Date(day);
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== day) return NaN;
  return time ? Date.parse(`${day}T${time}${zone ?? 'Z'}`) : midnight.getTime();
}

export function parseNumericTimestamp(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  return NaN;
}
