// Nickname sanitising and de-duplication (PRD §6.7, §9).

const MIN = 2;
const MAX = 12;

export function sanitizeNickname(raw: string): string {
  // keep letters, numbers, spaces and a few separators; collapse whitespace
  let n = (raw ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (n.length < MIN) n = 'Lutador';
  if (n.length > MAX) n = n.slice(0, MAX).trim();
  return n;
}

// Given the names already in the room, return a unique variant ("Name (2)").
export function uniqueNickname(desired: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(desired)) return desired;
  for (let i = 2; i < 100; i++) {
    const candidate = `${desired} (${i})`;
    if (!set.has(candidate)) return candidate;
  }
  return `${desired} (x)`;
}
