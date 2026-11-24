// @ts-check

/**
 * The domain layer for the Shenzhen Metro app.
 *
 * It answers three questions:
 *
 *   1. Which station did the passenger mean? The official catalogue carries a
 *      full pinyin and a pinyin-initials spelling for every station, so a
 *      search box takes `shenzhenbei`, `szb`, `shen zhen bei` or `深圳北` and
 *      lands on the right one.
 *
 *   2. When does the next train arrive? Shenzhen Metro publishes the first
 *      train, the last train and the peak and off-peak headway for every line
 *      and direction at every station. Those numbers are enough to lay out the
 *      day's arrivals: the headway is walked forward from the first train
 *      until the last one. What comes out is a schedule, not a live feed —
 *      the operator does not publish train positions — so the UI says so.
 *
 *   3. How do I get from A to B? The operator's own route planner answers
 *      that, with travel time, transfer walking time and fare.
 */

import { fetchJourney, fetchStationInfo } from './upstream.mjs';
import { createBrowserStorage } from './storage.mjs';

/** The operator publishes one timetable per kind of day. */
export const DAY_TYPES = /** @type {const} */ ({
  work: 'workDay',
  weekend: 'dayoff',
  holiday: 'holidays',
});

export const DAY_TYPE_LABELS = /** @type {const} */ ({
  work: '工作日',
  weekend: '休息日',
  holiday: '节假日',
});

/** Peak windows on a working day: 07:30–09:30 and 17:00–19:30. */
const PEAK_WINDOWS = [
  [7 * 60 + 30, 9 * 60 + 30],
  [17 * 60, 19 * 60 + 30],
];

/** Stations a newcomer is most likely to look for first. */
const POPULAR_CODES = ['0101', '0108', '0111', '0410', '0221', '0115', '0130', '0328'];

/* ------------------------------------------------------------- catalogue */

/** @typedef {{ id: string, name: string, from: string, to: string, color: string, stations: any[] }} LineInfo */
/** @typedef {{ code: string, name: string, qp: string, jp: string, lines: string[], facilities: string[] }} StationInfo */

/**
 * @typedef {object} Catalogue
 * @property {LineInfo[]} lines
 * @property {StationInfo[]} stations
 * @property {string} generatedAt
 */

/** @type {Catalogue | null} */
let catalogue = null;
/** @type {Promise<Catalogue> | null} */
let cataloguePromise = null;
/** @type {Map<string, StationInfo>} */
const stationIndex = new Map();
/** @type {Map<string, LineInfo>} */
const lineIndex = new Map();

/**
 * The station catalogue ships as a static file, so it is read once and kept.
 * @returns {Promise<Catalogue>}
 */
export function loadCatalogue() {
  if (catalogue) return Promise.resolve(catalogue);
  if (!cataloguePromise) {
    cataloguePromise = (async () => {
      const url = new URL('./stations.json', import.meta.url);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`station catalogue could not be read (${res.status})`);
      const data = /** @type {Catalogue} */ (await res.json());
      stationIndex.clear();
      lineIndex.clear();
      for (const station of data.stations) stationIndex.set(station.code, station);
      for (const line of data.lines) lineIndex.set(line.id, line);
      catalogue = data;
      return data;
    })().catch((error) => {
      cataloguePromise = null;
      throw error;
    });
  }
  return cataloguePromise;
}

/**
 * @param {string} code
 * @returns {StationInfo | undefined}
 */
export function stationByCode(code) {
  return stationIndex.get(code);
}

/**
 * @param {string} id
 * @returns {LineInfo | undefined}
 */
export function lineById(id) {
  return lineIndex.get(id);
}

/* --------------------------------------------------------------- search */

/**
 * @param {string} value
 * @returns {string}
 */
function normalise(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\-_'·.]/g, '');
}

/**
 * Score one station against a query. Higher is better; zero means no match.
 *
 * @param {StationInfo} station
 * @param {string} query already normalised
 * @param {string} raw the original query, for the Chinese name
 * @returns {number}
 */
function scoreStation(station, query, raw) {
  if (!query) return 0;
  const qp = normalise(station.qp);
  const jp = normalise(station.jp);
  const name = normalise(station.name);

  let score = 0;

  if (qp === query) score = Math.max(score, 1000);
  else if (qp.startsWith(query)) score = Math.max(score, 820 - (qp.length - query.length));
  else if (qp.includes(query)) score = Math.max(score, 640 - qp.indexOf(query));

  if (jp === query) score = Math.max(score, 960);
  else if (jp.startsWith(query)) score = Math.max(score, 780 - (jp.length - query.length) * 4);
  else if (jp.includes(query)) score = Math.max(score, 560);

  if (name === normalise(raw)) score = Math.max(score, 1000);
  else if (name.includes(normalise(raw))) score = Math.max(score, 700);

  // A query that reads like a line name is a weak match only.
  if (!score) {
    for (const id of station.lines) {
      const line = lineIndex.get(id);
      if (line && normalise(line.name).includes(query)) {
        score = Math.max(score, 260);
      }
    }
  }

  return score;
}

/**
 * Search the network by pinyin, pinyin initials or Chinese name.
 *
 * @param {string} query
 * @param {number} [limit]
 * @returns {Promise<Array<StationInfo & { score: number, matched: string }>>}
 */
export async function searchStations(query, limit = 24) {
  await loadCatalogue();
  const raw = String(query ?? '').trim();
  const normalised = normalise(raw);
  if (!normalised) return [];

  const results = [];
  for (const station of catalogue.stations) {
    const score = scoreStation(station, normalised, raw);
    if (score > 0) results.push({ ...station, score, matched: raw });
  }

  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-Hans'));
  return results.slice(0, limit);
}

/* -------------------------------------------------------- time helpers */

/**
 * `06:02` → 362 minutes past midnight.
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseClock(value) {
  const match = /(\d{1,2}):(\d{2})/.exec(String(value ?? ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

/**
 * @param {number} minutes
 * @returns {string}
 */
export function formatClock(minutes) {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const rest = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * Turn one published headway into minutes.
 *
 * The operator writes headways in prose: `2分钟`, `5分50秒`, `3-4分钟`,
 * `6-13分钟`, and sometimes `早2分15秒、晚3分钟。` — a different figure for the
 * morning and the evening peak. Each part is returned on its own with the tag
 * it carried, so the right figure can be picked for the time of day.
 *
 * @param {unknown} value
 * @returns {Array<{ minutes: number, tag: string }>}
 */
export function parseHeadway(value) {
  const text = String(value ?? '').replace(/～/g, '-').replace(/\s+/g, '');
  if (!text || text === '--') return [];

  const parts = text
    .split(/[、,，;；]/)
    .map((part) => part.trim())
    .filter(Boolean);

  /** @type {Array<{ minutes: number, tag: string }>} */
  const parsed = [];

  for (const part of parts) {
    const tag = part.startsWith('早') ? 'morning' : part.startsWith('晚') ? 'evening' : '';

    const range = /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*分(?:钟)?(?:\s*(\d+(?:\.\d+)?)\s*秒)?/.exec(part);
    if (range) {
      const low = Number(range[1]);
      const high = Number(range[2]) + (range[3] ? Number(range[3]) / 60 : 0);
      if (Number.isFinite(low) && Number.isFinite(high)) {
        parsed.push({ minutes: (low + high) / 2, tag });
      }
      continue;
    }

    const sequence = /(\d+(?:\.\d+)?)\s*分(?:钟)?(?:\s*(\d+(?:\.\d+)?)\s*秒)?/g;
    let found = false;
    for (const match of part.matchAll(sequence)) {
      found = true;
      const minutes = Number(match[1]);
      const seconds = match[2] ? Number(match[2]) : 0;
      if (Number.isFinite(minutes)) parsed.push({ minutes: minutes + seconds / 60, tag });
    }
    if (found) continue;

    const secondsOnly = /(\d+(?:\.\d+)?)\s*秒/.exec(part);
    if (secondsOnly) {
      const seconds = Number(secondsOnly[1]);
      if (Number.isFinite(seconds)) parsed.push({ minutes: seconds / 60, tag });
    }
  }

  return parsed;
}

/**
 * @param {number} minutes
 * @param {string} dayType
 * @returns {boolean}
 */
export function isPeak(minutes, dayType) {
  if (dayType !== 'work') return false;
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to);
}

/**
 * The headway to use at a given moment.
 *
 * @param {any} entry one published schedule row
 * @param {number} at minutes past midnight
 * @param {string} dayType
 * @returns {number | null}
 */
export function headwayAt(entry, at, dayType) {
  const peak = parseHeadway(entry?.gaofenjiange);
  const offPeak = parseHeadway(entry?.pingjunjiange);
  const chosen = isPeak(at, dayType) ? (peak.length ? peak : offPeak) : offPeak.length ? offPeak : peak;
  if (!chosen.length) return null;

  const tagged = chosen.filter((item) => item.tag);
  if (tagged.length) {
    const wanted = at < 12 * 60 ? 'morning' : 'evening';
    if (isPeak(at, dayType)) {
      const hit = tagged.find((item) => item.tag === wanted);
      if (hit) return hit.minutes;
    }
  }

  const total = chosen.reduce((sum, item) => sum + item.minutes, 0);
  return total / chosen.length;
}

/**
 * Lay out the day's arrivals for one direction.
 *
 * @param {any} entry one published schedule row
 * @param {string} firstKey
 * @param {string} lastKey
 * @param {string} dayType
 * @returns {{ first: number | null, last: number | null, times: number[] }}
 */
export function buildSchedule(entry, firstKey, lastKey, dayType) {
  const first = parseClock(entry?.[firstKey]);
  let last = parseClock(entry?.[lastKey]);
  if (first === null) return { first: null, last: null, times: [] };
  if (last === null) last = first;
  // A last train of 00:33 is a train of the next morning.
  if (last < first) last += 1440;

  /** @type {number[]} */
  const times = [];
  let cursor = first;
  let guard = 0;
  while (cursor <= last && guard < 800) {
    guard += 1;
    times.push(cursor);
    const step = headwayAt(entry, cursor, dayType) ?? 6;
    cursor += Math.max(1, step);
  }
  return { first, last, times };
}

/**
 * The next arrivals at or after `now`.
 *
 * @param {number[]} times
 * @param {number} now
 * @param {number} [count]
 * @returns {Array<{ clock: string, minutes: number, inMinutes: number, nextDay: boolean }>}
 */
export function nextArrivals(times, now, count = 4) {
  return times
    .filter((time) => time >= now - 0.5)
    .slice(0, count)
    .map((time) => ({
      clock: formatClock(time),
      minutes: time,
      inMinutes: Math.max(0, Math.round(time - now)),
      nextDay: time >= 1440,
    }));
}

/**
 * The kind of day a date falls on, as far as the operator's own timetables go.
 * Public holidays are not published with the timetables, so the caller can
 * override this.
 *
 * @param {Date} date
 * @returns {'work' | 'weekend'}
 */
export function guessDayType(date) {
  const day = date.getDay();
  return day === 0 || day === 6 ? 'weekend' : 'work';
}

/* -------------------------------------------------------------- station */

/**
 * Everything the app shows for one station.
 *
 * @param {string} code
 * @param {{ dayType?: string, now?: number }} [options]
 */
export async function stationDetail(code, options = {}) {
  await loadCatalogue();
  const station = stationIndex.get(code);
  if (!station) throw new NotFoundError(`no station with code ${code}`);

  const dayType = options.dayType && DAY_TYPES[options.dayType] ? options.dayType : 'work';
  const now = options.now ?? currentMinutes();

  const raw = await fetchStationInfo(code);
  const rows = Array.isArray(raw?.workDay) ? raw.workDay : [];
  const dayRows = Array.isArray(raw?.[DAY_TYPES[dayType]]) ? raw[DAY_TYPES[dayType]] : rows;

  /** @type {any[]} */
  const directions = [];

  for (const row of dayRows) {
    const lineName = String(row?.suoshuluxian ?? '');
    const line = catalogue.lines.find((item) => item.name === lineName);
    const lineId = line?.id ?? '';

    for (const [towardKey, towardEnKey, firstKey, lastKey] of [
      ['xinshifangxiang', 'xinshifangxiangen', 'shoubanche', 'mobanche'],
      ['xinshifangxiangxia', 'xinshifangxiangxiaen', 'shoubanchexia', 'mobanchexia'],
    ]) {
      const toward = String(row?.[towardKey] ?? '').replace(/站$/, '');
      if (!toward) continue;
      const schedule = buildSchedule(row, firstKey, lastKey, dayType);
      const arrivals = nextArrivals(schedule.times, now);
      directions.push({
        lineId,
        lineName: lineName || line?.name || '',
        lineColor: line?.color ?? '#666666',
        toward,
        towardEn: String(row?.[towardEnKey] ?? ''),
        first: schedule.first === null ? '' : formatClock(schedule.first),
        last: schedule.last === null ? '' : formatClock(schedule.last),
        peakHeadway: String(row?.gaofenjiange ?? ''),
        offPeakHeadway: String(row?.pingjunjiange ?? ''),
        // The operator does not publish a headway for every station and
        // direction; where it is missing the arrivals fall back to a default
        // interval, and the page says so.
        headwayKnown: parseHeadway(row?.gaofenjiange).length > 0 || parseHeadway(row?.pingjunjiange).length > 0,
        arrivals,
        ended: arrivals.length === 0,
        nextDayFirst: schedule.first === null ? '' : formatClock(schedule.first),
      });
    }
  }

  const exits = (Array.isArray(raw?.outAndText) ? raw.outAndText : []).map((item) => ({
    code: String(item?.outt ?? '').replace(/出入口$/, ''),
    text: String(item?.textt ?? ''),
  }));

  const buses = (Array.isArray(raw?.busInof) ? raw.busInof : [])
    .map((item) => ({
      exit: String(item?.chukou ?? ''),
      stops: (Array.isArray(item?.busOutInfo) ? item.busOutInfo : []).map((bus) => ({
        name: String(bus?.busName ?? ''),
        routes: String(bus?.busInfo ?? ''),
      })),
    }))
    .filter((group) => group.stops.length > 0);

  return {
    station: {
      code: station.code,
      name: station.name,
      qp: station.qp,
      jp: station.jp,
      lines: station.lines.map((id) => ({
        id,
        name: lineIndex.get(id)?.name ?? id,
        color: lineIndex.get(id)?.color ?? '#666666',
      })),
      facilities: station.facilities,
    },
    dayType,
    dayTypeLabel: DAY_TYPE_LABELS[dayType] ?? '',
    now,
    clock: formatClock(now),
    directions,
    exits,
    buses,
    intro: String(raw?.siteIntroduce ?? ''),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Minutes past midnight in the visitor's own timezone.
 * @returns {number}
 */
export function currentMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}

/* -------------------------------------------------------------- journey */

/**
 * @param {any} raw
 * @returns {any}
 */
export function normaliseJourney(raw) {
  const rows = (Array.isArray(raw?.lineList) ? raw.lineList : []).filter(
    (row) => row && row.line && row.line !== 'xx',
  );
  const seconds = Number(raw?.useTime ?? 0);
  return {
    seconds,
    minutes: Math.round(seconds / 60),
    fare: Number(raw?.ticketPrice ?? 0),
    businessFare: Number(raw?.ticketPricesw ?? 0),
    transfers: Math.max(0, rows.length - 1),
    segments: rows.map((row) => ({
      line: String(row.line ?? ''),
      lineName: String(row.lineName ?? ''),
      from: String(row.departureStation ?? ''),
      to: String(row.arriveStation ?? ''),
      travelSeconds: Number(row.travelTime ?? 0),
      transferSeconds: Number(row.transferTime ?? 0),
      transferMetres: Number(row.transferDistance ?? 0),
      first: String(row.firstTime ?? ''),
      last: String(row.endTime ?? ''),
      peakHeadway: String(row.highNterval ?? ''),
      offPeakHeadway: String(row.shortNterval ?? ''),
      via: String(row.passdepotname ?? '')
        .split('|')
        .map((item) => item.trim())
        .filter(Boolean),
    })),
  };
}

/**
 * A route between two stations.
 *
 * @param {string} from
 * @param {string} to
 * @param {0 | 1} [ridingType]
 */
export async function journey(from, to, ridingType = 0) {
  await loadCatalogue();
  const origin = stationIndex.get(from);
  const destination = stationIndex.get(to);
  if (!origin || !destination) throw new NotFoundError('unknown station');

  const raw = await fetchJourney(from, to, ridingType);
  return {
    from: { code: origin.code, name: origin.name, qp: origin.qp },
    to: { code: destination.code, name: destination.name, qp: destination.qp },
    ridingType,
    ...normaliseJourney(raw),
    fetchedAt: new Date().toISOString(),
  };
}

/* ----------------------------------------------------------- favourites */

export class NotFoundError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

const storage = createBrowserStorage({ namespace: 'szmetro' });

/**
 * @returns {Array<{ code: string, name: string, qp: string, lines: string[] }>}
 */
export function listFavourites() {
  const items = storage.get('favourites');
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item && typeof item.code === 'string');
}

/**
 * @param {string} code
 */
export function addFavourite(code) {
  const station = stationIndex.get(code);
  if (!station) throw new NotFoundError(`no station with code ${code}`);
  const items = listFavourites();
  if (!items.some((item) => item.code === code)) {
    items.push({ code: station.code, name: station.name, qp: station.qp, lines: station.lines });
    storage.set('favourites', items);
  }
  return items;
}

/**
 * @param {string} code
 */
export function removeFavourite(code) {
  const items = listFavourites().filter((item) => item.code !== code);
  storage.set('favourites', items);
  return items;
}

/* ------------------------------------------------------------ bootstrap */

/**
 * The first screen needs the network overview and a few starting points.
 */
export async function bootstrap() {
  const data = await loadCatalogue();
  const popular = POPULAR_CODES.map((code) => stationIndex.get(code)).filter(Boolean);

  /** @type {Record<string, Array<{ code: string, name: string, qp: string }>>} */
  const allStations = {};
  for (const line of data.lines) {
    allStations[line.id] = line.stations.map((entry) => {
      const station = stationIndex.get(entry.code);
      return { code: entry.code, name: station?.name ?? entry.name, qp: station?.qp ?? entry.qp };
    });
  }

  return {
    generatedAt: data.generatedAt,
    lines: data.lines.map((line) => ({
      id: line.id,
      name: line.name,
      from: line.from,
      to: line.to,
      color: line.color,
      stations: line.stations.length,
    })),
    allStations,
    stationCount: data.stations.length,
    popular: popular.map((station) => ({
      code: /** @type {StationInfo} */ (station).code,
      name: /** @type {StationInfo} */ (station).name,
      qp: /** @type {StationInfo} */ (station).qp,
      jp: /** @type {StationInfo} */ (station).jp,
      lines: /** @type {StationInfo} */ (station).lines,
    })),
  };
}
