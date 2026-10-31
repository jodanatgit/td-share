import type { Timestamp } from 'firebase/firestore';

export interface TdEvent {
  id: string;
  name: string;
  createdBy: string;
  endsAt: Timestamp; // kept as a Timestamp: positions must carry exactly this value as expireAt (firestore.rules)
}

// A sharer's latest position (events/{id}/members/{userName})
export interface Member {
  userName: string;
  lat: number;
  lng: number;
  accuracy: number;
  updatedAt: Date | null;
}

// One point of someone's track (events/{id}/points)
export interface TrackPoint {
  userName: string;
  lat: number;
  lng: number;
  at: Date | null;
}

// A place someone marked on the map, with info (events/{id}/places)
export interface Place {
  id: string;
  title: string;
  info: string;
  lat: number;
  lng: number;
  createdBy: string;
}

// An uploaded GPX file (events/{id}/routes), see src/gpx.ts for the coordinate layout
export interface Route {
  id: string;
  name: string;
  color: string;
  coords: number[];
  breaks: number[];
  waypoints: { lat: number; lng: number; name: string }[];
  createdBy: string;
}

// "Johan kom fram till PT-PASS", "Johan har klarat 3 km av Halvan" (events/{id}/arrivals, written by functions/arrivals.js)
export interface Arrival {
  id: string;
  userName: string;
  kind: 'place' | 'route' | 'progress' | 'finish';
  targetName: string;
  at: Date | null;
  // progress along a route ('progress' every km, 'finish' at the end)
  km?: number;
  coveredM?: number;
  elapsedS?: number;
  splitM?: number; // the latest km
  splitS?: number;
  remainingM?: number | null;
  lengthM?: number;
}
