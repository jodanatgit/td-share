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
