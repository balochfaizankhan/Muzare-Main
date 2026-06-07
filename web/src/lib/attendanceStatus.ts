import type { Attendance } from "./offline-db";

export const formatLocalDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const todayLocalDateKey = () => formatLocalDateKey(new Date());

export const normalizeAttendanceDateKey = (value: string | null | undefined) => {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  return formatLocalDateKey(parsed);
};

export const previousLocalDateKey = (dateKey: string) => {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return "";
  const localDate = new Date(year, month - 1, day, 12, 0, 0, 0);
  localDate.setDate(localDate.getDate() - 1);
  return formatLocalDateKey(localDate);
};

export const attendanceStatusKey = (labourerId: string, dateKey: string) => `${labourerId}:${dateKey}`;

export type DuplicateAttendanceWarning = {
  key: string;
  labourerId: string;
  date: string;
  recordIds: string[];
};

const recordTimestamp = (entry: Attendance) => {
  const updatedAt = Date.parse(entry.updatedAt);
  if (!Number.isNaN(updatedAt)) return updatedAt;
  const createdAt = Date.parse(entry.createdAt);
  return Number.isNaN(createdAt) ? 0 : createdAt;
};

export function buildAttendanceStatusMap(entries: Attendance[], targetDate: string) {
  const normalizedTargetDate = normalizeAttendanceDateKey(targetDate);
  const selected = new Map<string, { id: string; status: Attendance["status"]; timestamp: number }>();
  const duplicateIds = new Map<string, Set<string>>();

  for (const entry of entries) {
    const entryDate = normalizeAttendanceDateKey(entry.date);
    if (!entry.labourerId || entryDate !== normalizedTargetDate) continue;

    const key = attendanceStatusKey(entry.labourerId, normalizedTargetDate);
    const timestamp = recordTimestamp(entry);
    const existing = selected.get(key);

    if (existing) {
      const ids = duplicateIds.get(key) ?? new Set<string>([existing.id]);
      ids.add(entry.id);
      duplicateIds.set(key, ids);
    }

    if (!existing || timestamp > existing.timestamp || (timestamp === existing.timestamp && entry.id > existing.id)) {
      selected.set(key, { id: entry.id, status: entry.status, timestamp });
    }
  }

  return {
    statuses: new Map([...selected.entries()].map(([key, value]) => [key, value.status])),
    duplicates: [...duplicateIds.entries()].map(([key, ids]) => {
      const [labourerId, date] = key.split(":");
      return { key, labourerId, date, recordIds: [...ids] };
    }),
  };
}
