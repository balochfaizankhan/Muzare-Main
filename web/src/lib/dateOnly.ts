const dateKeyPattern = /^(\d{4})-(\d{2})-(\d{2})/;

export const ATTENDANCE_PRINT_DAYS_PER_CHUNK = 40;

export function formatLocalDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseLocalDateKey(value: string) {
  const match = dateKeyPattern.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, monthIndex, day);
  return date.getFullYear() === year && date.getMonth() === monthIndex && date.getDate() === day ? date : null;
}

export function normalizeDateKey(value: string) {
  const date = parseLocalDateKey(value);
  return date ? formatLocalDateKey(date) : value.trim();
}

export function buildInclusiveDateKeys(from: string, to: string, fallbackDates: string[] = []) {
  const start = parseLocalDateKey(from);
  const end = parseLocalDateKey(to);
  if (start && end && start <= end) {
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const toKey = formatLocalDateKey(end);
    const dates: string[] = [];
    while (formatLocalDateKey(cursor) <= toKey) {
      dates.push(formatLocalDateKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
  }
  return [...new Set(fallbackDates.map(normalizeDateKey))].sort();
}

export function chunkAttendanceDateKeys(dates: string[]) {
  const chunks: string[][] = [];
  for (let index = 0; index < dates.length; index += ATTENDANCE_PRINT_DAYS_PER_CHUNK) {
    chunks.push(dates.slice(index, index + ATTENDANCE_PRINT_DAYS_PER_CHUNK));
  }
  return chunks;
}
