export interface DayWindow {
  date: string;
  startUtc: Date;
  endUtc: Date;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolves the UTC `[startUtc, endUtc)` bounds for a local calendar date
 * (`YYYY-MM-DD`) and timezone offset in minutes east of UTC (e.g., IST = 330).
 */
export function resolveDayWindow(input: {
  date?: string;
  tzOffsetMinutes?: number;
  now?: Date;
}): DayWindow {
  const tzOffsetMinutes = input.tzOffsetMinutes ?? 330;
  const now = input.now ?? new Date();

  let dateStr = input.date;
  if (!dateStr || !ISO_DATE_RE.test(dateStr)) {
    const shifted = new Date(now.getTime() + tzOffsetMinutes * 60_000);
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const d = String(shifted.getUTCDate()).padStart(2, '0');
    dateStr = `${y}-${m}-${d}`;
  }

  const [yStr, mStr, dStr] = dateStr.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);

  const localMidnightAsUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const startUtc = new Date(localMidnightAsUtcMs - tzOffsetMinutes * 60_000);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60_000);

  return { date: dateStr, startUtc, endUtc };
}
