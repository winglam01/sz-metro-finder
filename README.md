# 深圳地铁拼音查站 · Shenzhen Metro Pinyin

Type a station name in **pinyin** and get the arrival times for every line and
every direction at that station — plus the first train, the last train, the
headway, the exits and the nearby buses. All of it comes from the Shenzhen
Metro Group's own public endpoints.

No backend, no build step, no account, no tracking.

## What it does

- **Pinyin search** — `shenzhenbei`, `szb`, `shen zhen bei` and `深圳北` all
  land on 深圳北站. The full pinyin and the pinyin initials of every one of the
  351 stations come from the operator's own station file.
- **Arrival board** — for each line and direction at the station: the next
  four trains with a countdown, the first train, the last train, the peak
  headway and the off-peak headway.
- **Three timetables** — 工作日 / 休息日 / 节假日, because the operator runs a
  different timetable for each.
- **Exits and buses** — which exit leads where, and which bus stops at it.
- **Route planner** — the official journey plan with the route, the transfer
  walking distance, the estimated time and the fare.
- **Line map** — all 17 lines, every station, the official line colour.
- **Saved stations** — kept on the device.

## Live site

| | |
|---|---|
| GitHub Pages | `https://winglam01.github.io/sz-metro-finder/` |

## Install it on your phone

This is a progressive web app, so there is nothing to download from a store.

**iPhone (Safari)** — open the link, tap **Share**, then **Add to Home Screen**.
**Android (Chrome)** — open the link, then **⋮ → Install app**.

It launches full screen with no browser chrome, keeps working offline with the
last data it loaded, and stays up to date on the next visit.

## Where the data comes from

Everything is live, free and public data from the Shenzhen Metro Group.

| | | |
|---|---|---|
| Station catalogue | 351 stations, 17 lines | `szmc.net/styles/index/js/metroStationsList.js` |
| Station information | exits, buses, first/last train, headways | `POST szmc.net/zdxx` |
| Journey planning | routes, transfer times, fares | `POST szmc.net/algorithm/Ticketing/MinTimeJson.do` |
| Line colours | the official badge of each line | `szmc.net/styles/index/images/l{n}-c2.png` |

### About the arrival times

Shenzhen Metro does **not** publish live train positions — there is no public
real-time feed to read. What the operator does publish, for every station,
line and direction, is the first train, the last train, the peak headway and
the off-peak headway.

The app lays those numbers out into the day's arrivals: it walks the headway
forward from the first train until the last one, using the peak headway inside
the morning and evening peaks (07:30–09:30 and 17:00–19:30 on a working day)
and the off-peak headway outside them. What comes out is a **schedule**, not a
live feed, and the page says so rather than pretending otherwise.

The headways are published in prose — `2分钟`, `5分50秒`, `3-4分钟`,
`6-13分钟`, and sometimes `早2分15秒、晚3分钟。` with a different figure for the
morning and the evening peak. Those are parsed apart, and a range is taken as
its midpoint. A few stations publish no headway at all; there the arrivals
fall back to a default interval and the page says that too.

The first train, the last train, the headway, the exits and the buses are the
operator's own figures and are shown unmodified.

### Timetable notes

- The operator publishes three timetables and the app can switch between
  them. Public holidays are not published with the timetables, so a holiday
  that falls on a weekday is picked up by switching to 节假日.
- A terminus has no trains running towards itself, so the operator publishes
  no times for that direction and the app leaves it out.

## How it works

The page is plain ES modules and inline SVG. There is no bundler, no framework
and no third-party code — the browser loads the files as they are. Because the
Shenzhen Metro endpoints send `Access-Control-Allow-Origin: *`, the page calls
them directly from the browser and there is no server in the middle.

```
index.html          app shell
app.js              hash routing and rendering
styles.css          theme tokens and layout
sw.js               offline shell cache
manifest.json       install metadata
data/stations.json  the built station catalogue
data/upstream.mjs   endpoint access, caching, normalisation
data/domain.mjs     search, timetable arithmetic, routes, favourites
data/api.mjs        the API surface the page talks to
data/storage.mjs    persistence with a quota-safe fallback
```

A few decisions worth knowing about:

- **The station catalogue is built ahead of time, not at runtime.** The
  operator's station file is a JavaScript bundle; `tools/build-szmetro-data.mjs`
  reads it and writes `data/stations.json`, and the same run reads the official
  line badges to get each line's colour. The page then reads one static file
  and searches it locally, so the search is instant and works offline.
- **Caching is honest.** Station information is kept for half an hour and a
  route for ten minutes. A failed call is never cached — an empty collection
  throws rather than being stored.
- **The requests stay simple.** The bodies are form-encoded, which is on the
  CORS safelist, so the calls need no preflight and no custom headers.
- **No build step means no build toolchain to install.**

## Run it locally

Any static file server works. ES modules and service workers need a real
`http://` origin, so `file://` will not do.

```bash
node tools/serve-web.mjs 8082 .
```

Then open <http://127.0.0.1:8082/>.

## Rebuild the station catalogue

```bash
node tools/build-szmetro-data.mjs
```

That re-reads the operator's station bundle and the line badges and rewrites
`data/stations.json`.

## Check it against the live endpoints

```bash
node tools/smoke-szmetro-web.mjs
```

This drives the real data layer against the real upstream endpoints and
asserts the station catalogue, the pinyin search, the timetable arithmetic,
the arrival board, the route planner and the favourites round trip. It needs
network access and takes about fifteen seconds.

## Icons

The icons are generated, not hand-drawn — `node tools/make-szmetro-icons.mjs`
paints the same train mark the app header uses and writes the PNGs.

---

The transport data is © the Shenzhen Metro Group. This repository contains no
code licence yet — add one if you plan to reuse it.
