export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function parseDay(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

export function shiftDay(value: string, offset: number): string {
  const date = parseDay(value);
  date.setDate(date.getDate() + offset);
  return localDate(date);
}

export function friendlyDay(value: string, options?: Intl.DateTimeFormatOptions): string {
  return parseDay(value).toLocaleDateString("en-GB", options ?? { weekday: "long", day: "numeric", month: "long" });
}

export function completionDay(timestamp: string): string {
  return localDate(new Date(timestamp));
}

export function dayRange(end: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => shiftDay(end, index - count + 1));
}
