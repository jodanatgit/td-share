// Reads a GPX file into what an event route stores (events/{id}/routes): Firestore can't nest arrays, so the
// line is a flat [lat, lng, lat, lng, ...] list and `breaks` holds the point index where each new segment starts.

export interface ParsedGpx {
  name: string;
  coords: number[];
  breaks: number[];
  waypoints: { lat: number; lng: number; name: string }[];
}

const MAX_POINTS = 8000; // keeps a route document far below Firestore's 1 MB limit
const MAX_WAYPOINTS = 200;

const round = (x: number) => Math.round(x * 1e6) / 1e6; // ~10 cm

export function parseGpx(text: string, fileName: string): ParsedGpx {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.getElementsByTagName('parsererror').length) throw new Error('Filen är inte en giltig GPX-fil.');

  const pointsOf = (parent: Element, tag: string) =>
    [...parent.getElementsByTagNameNS('*', tag)]
      .map((p) => [Number(p.getAttribute('lat')), Number(p.getAttribute('lon'))])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180);

  // Track segments and planned routes each become a segment of the line
  const segments = [
    ...[...xml.getElementsByTagNameNS('*', 'trkseg')].map((s) => pointsOf(s, 'trkpt')),
    ...[...xml.getElementsByTagNameNS('*', 'rte')].map((r) => pointsOf(r, 'rtept'))
  ].filter((s) => s.length > 1);

  const waypoints = [...xml.getElementsByTagNameNS('*', 'wpt')]
    .slice(0, MAX_WAYPOINTS)
    .map((w) => ({
      lat: Number(w.getAttribute('lat')),
      lng: Number(w.getAttribute('lon')),
      name: (w.getElementsByTagNameNS('*', 'name')[0]?.textContent || '').trim().slice(0, 80)
    }))
    .filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng))
    .map((w) => ({ ...w, lat: round(w.lat), lng: round(w.lng) }));

  if (!segments.length && !waypoints.length) throw new Error('Hittade inga spår, rutter eller punkter i filen.');

  // Long recordings are thinned out evenly, keeping each segment's first and last point
  const total = segments.reduce((n, s) => n + s.length, 0);
  const step = Math.max(1, Math.ceil(total / MAX_POINTS));
  const coords: number[] = [];
  const breaks: number[] = [];
  for (const s of segments) {
    breaks.push(coords.length / 2);
    s.forEach(([lat, lng], i) => {
      if (i % step === 0 || i === s.length - 1) coords.push(round(lat), round(lng));
    });
  }

  const gpxName =
    xml.querySelector('metadata > name')?.textContent || xml.getElementsByTagNameNS('*', 'trk')[0]?.getElementsByTagNameNS('*', 'name')[0]?.textContent;
  const name = (gpxName || fileName.replace(/\.gpx$/i, '')).trim().slice(0, 80) || 'Rutt';

  return { name, coords, breaks, waypoints };
}

// The line as Leaflet polylines, one per segment
export function toLines(coords: number[], breaks: number[]): [number, number][][] {
  const starts = breaks.length ? breaks : [0];
  return starts
    .map((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1] : coords.length / 2;
      const line: [number, number][] = [];
      for (let p = start; p < end; p++) line.push([coords[p * 2], coords[p * 2 + 1]]);
      return line;
    })
    .filter((l) => l.length > 1);
}
