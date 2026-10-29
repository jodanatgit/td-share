// "johan" -> "Johan", "hanna.swedenklef" -> "Hanna Swedenklef"
export const displayName = (userName: string) =>
  userName
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

export const initials = (userName: string) =>
  userName
    .split('.')
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
    .slice(0, 2);

const COLORS = ['#e8762a', '#2f6fd8', '#1f9d6b', '#c2410c', '#8b5cf6', '#db2777', '#0e7490', '#a16207', '#4d7c0f', '#be123c'];

// A stable color per person, so marker and track match on every phone
export const colorFor = (userName: string) => {
  let h = 0;
  for (const c of userName) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};

export const ago = (d: Date | null, now: number) => {
  if (!d) return 'nyss';
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (s < 60) return 'nyss';
  if (s < 3600) return `${Math.round(s / 60)} min sedan`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min sedan`;
};
