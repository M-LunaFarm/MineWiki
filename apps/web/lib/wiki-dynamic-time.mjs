const WIKI_TIME_ZONE = 'Asia/Seoul';
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: WIKI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: WIKI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function formatWikiDynamicTime(mode, date, now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  const today = zonedDateParts(now);

  if (mode === 'datetime') {
    const parts = zonedDateTimeParts(now);
    return {
      text: `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`,
      dateTime: now.toISOString(),
    };
  }

  const target = parseCalendarDate(date);
  if (!target) return null;

  if (mode === 'age') {
    if (compareCalendarDate(target, today) > 0) {
      return { text: 'invalid date', dateTime: target.source };
    }
    let age = today.year - target.year;
    if (today.month < target.month || (today.month === target.month && today.day < target.day)) {
      age -= 1;
    }
    return { text: String(age), dateTime: target.source };
  }

  if (mode === 'dday') {
    const difference = calendarOrdinal(today) - calendarOrdinal(target);
    return {
      text: difference > 0 ? `+${difference}` : `-${Math.abs(difference)}`,
      dateTime: target.source,
    };
  }

  return null;
}

function zonedDateParts(date) {
  const values = Object.fromEntries(
    DATE_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function zonedDateTimeParts(date) {
  const values = Object.fromEntries(
    DATE_TIME_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function parseCalendarDate(value) {
  if (typeof value !== 'string') return null;
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return null;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > (monthLengths[month - 1] ?? 0)) return null;
  return { year, month, day, source: value };
}

function compareCalendarDate(left, right) {
  return calendarOrdinal(left) - calendarOrdinal(right);
}

function calendarOrdinal({ year, month, day }) {
  const previousYear = year - 1;
  const leapDays = Math.floor(previousYear / 4) - Math.floor(previousYear / 100) + Math.floor(previousYear / 400);
  const monthOffsets = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const afterFebruary = month > 2;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return previousYear * 365 + leapDays + (monthOffsets[month - 1] ?? 0) + (afterFebruary && leapYear ? 1 : 0) + day;
}

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}
