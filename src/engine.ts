// Word engine: dictionary indexing, candidate search, and the exact
// best-partition solver (max total reward from disjoint words in a rack).
import * as fs from "node:fs";

export const LETTER_VALUE = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
];
// Standard bag (no blanks), A..Z
export const BAG_COUNTS = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
];
export const BAG_SIZE = 98;

export function reward(base: number, len: number): number {
  if (len <= 3) return base;
  if (len === 4) return Math.floor((base * 3) / 2);
  if (len === 5) return base * 2;
  if (len === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

export type Counts = Uint8Array; // length 26

export interface Dict {
  words: string[];
  len: Uint8Array;
  mask: Uint32Array;
  rew: Uint16Array;
  counts: Uint8Array; // flat, 26 per word
  n: number;
}

export function loadDict(path: string, maxLen = 15): Dict {
  let raw = fs
    .readFileSync(path, "utf8")
    .split("\n")
    .map((w) => w.trim().toUpperCase())
    .filter((w) => w.length >= 2 && w.length <= maxLen && /^[A-Z]+$/.test(w));
  // One representative per anagram class: same letters, same reward.
  const seen = new Set<string>();
  const raw2: string[] = [];
  for (const w of raw) {
    const k = [...w].sort().join("");
    if (seen.has(k)) continue;
    seen.add(k);
    raw2.push(w);
  }
  raw = raw2;
  const n = raw.length;
  const d: Dict = {
    words: raw,
    len: new Uint8Array(n),
    mask: new Uint32Array(n),
    rew: new Uint16Array(n),
    counts: new Uint8Array(n * 26),
    n,
  };
  for (let i = 0; i < n; i++) {
    const w = raw[i]!;
    let base = 0;
    let m = 0;
    for (let j = 0; j < w.length; j++) {
      const c = w.charCodeAt(j) - 65;
      d.counts[i * 26 + c]!++;
      m |= 1 << c;
      base += LETTER_VALUE[c]!;
    }
    d.len[i] = w.length;
    d.mask[i] = m >>> 0;
    d.rew[i] = reward(base, w.length);
  }
  return d;
}

export function countsFromMap(rack: Map<string, number>): Counts {
  const c = new Uint8Array(26);
  for (const [k, v] of rack) {
    const i = k.charCodeAt(0) - 65;
    if (i >= 0 && i < 26) c[i] = Math.min(255, c[i]! + v);
  }
  return c;
}
export function countsFromString(s: string): Counts {
  const c = new Uint8Array(26);
  for (let j = 0; j < s.length; j++) c[s.charCodeAt(j) - 65]!++;
  return c;
}
export function countsToString(c: Counts): string {
  let s = "";
  for (let i = 0; i < 26; i++) s += String.fromCharCode(65 + i).repeat(c[i]!);
  return s;
}
function maskOf(c: Counts): number {
  let m = 0;
  for (let i = 0; i < 26; i++) if (c[i]) m |= 1 << i;
  return m >>> 0;
}
function total(c: Counts): number {
  let t = 0;
  for (let i = 0; i < 26; i++) t += c[i]!;
  return t;
}

// All dictionary word indices that can be spelled from `c`.
export function candidates(d: Dict, c: Counts): Int32Array {
  const m = maskOf(c);
  const notM = ~m >>> 0;
  const t = total(c);
  const out: number[] = [];
  const { len, mask, counts } = d;
  for (let i = 0; i < d.n; i++) {
    if (len[i]! > t) continue;
    if ((mask[i]! & notM) !== 0) continue;
    const o = i * 26;
    let ok = true;
    let mm = mask[i]!;
    while (mm) {
      const b = 31 - Math.clz32(mm & -mm);
      if (counts[o + b]! > c[b]!) {
        ok = false;
        break;
      }
      mm &= mm - 1;
    }
    if (ok) out.push(i);
  }
  return Int32Array.from(out);
}

// Filter a candidate list down to those fitting `c`.
function fitsList(d: Dict, list: Int32Array | number[], c: Counts): number[] {
  const out: number[] = [];
  for (let k = 0; k < list.length; k++) {
    const i = list[k]!;
    const o = i * 26;
    let ok = true;
    let mm = d.mask[i]!;
    while (mm) {
      const b = 31 - Math.clz32(mm & -mm);
      if (d.counts[o + b]! > c[b]!) {
        ok = false;
        break;
      }
      mm &= mm - 1;
    }
    if (ok) out.push(i);
  }
  return out;
}

export interface Partition {
  score: number;
  words: number[]; // dict indices
}

// Max-reward partition of rack `c` into disjoint words (unused tiles
// allowed). Branch-and-bound over candidates sorted by reward desc,
// combinations in nondecreasing index order. Bound: 3x remaining value.
// Exact unless the time limit hits, in which case best-so-far.
export function bestPartition(
  d: Dict,
  c: Counts,
  cands?: Int32Array | number[],
  timeLimitMs = 60,
): Partition {
  const list = Array.from(cands ?? candidates(d, c)).sort(
    (a, b) => d.rew[b]! - d.rew[a]! || d.len[a]! - d.len[b]!,
  );
  const rem = new Uint8Array(c);
  let remVal = 0;
  for (let i = 0; i < 26; i++) remVal += rem[i]! * LETTER_VALUE[i]!;
  let best: Partition = { score: 0, words: [] };
  const stack: number[] = [];
  const deadline = performance.now() + timeLimitMs;
  let nodes = 0;
  let timedOut = false;
  const visited = new Set<string>();

  function dfs(lst: number[], score: number) {
    if (score > best.score) best = { score, words: [...stack] };
    if (timedOut) return;
    if ((++nodes & 255) === 0 && performance.now() > deadline) {
      timedOut = true;
      return;
    }
    for (let k = 0; k < lst.length; k++) {
      const w = lst[k]!;
      // Bound: even if every remaining tile scored at 3x.
      if (score + 3 * remVal <= best.score) return;
      // Reward-desc ordering: this word and later ones can add at most
      // rew[w] each; cheap secondary bound.
      const o = w * 26;
      let wv = 0;
      for (let i = 0; i < 26; i++) {
        rem[i]! -= d.counts[o + i]!;
        wv += d.counts[o + i]! * LETTER_VALUE[i]!;
      }
      remVal -= wv;
      const key = String.fromCharCode.apply(null, rem as unknown as number[]);
      if (!visited.has(key)) {
        visited.add(key);
        stack.push(w);
        const next: number[] = [];
        for (let j = k; j < lst.length; j++) {
          const x = lst[j]!;
          const ox = x * 26;
          let ok = true;
          let mm = d.mask[x]!;
          while (mm) {
            const b = 31 - Math.clz32(mm & -mm);
            if (d.counts[ox + b]! > rem[b]!) {
              ok = false;
              break;
            }
            mm &= mm - 1;
          }
          if (ok) next.push(x);
        }
        dfs(next, score + d.rew[w]!);
        stack.pop();
      }
      remVal += wv;
      for (let i = 0; i < 26; i++) rem[i]! += d.counts[o + i]!;
      if (timedOut) return;
    }
  }
  dfs(list, 0);
  return best;
}

// Fast upper-ish estimate: best single word + greedy remainder (used in
// Monte Carlo where the exact solver is too slow).
export function greedyPartition(d: Dict, c: Counts, cands?: Int32Array | number[]): Partition {
  const rem = new Uint8Array(c);
  let lst = Array.from(cands ?? candidates(d, c));
  const words: number[] = [];
  let score = 0;
  for (;;) {
    let bw = -1;
    let br = 0;
    for (const w of lst)
      if (d.rew[w]! > br) {
        br = d.rew[w]!;
        bw = w;
      }
    if (bw < 0) break;
    words.push(bw);
    score += br;
    for (let i = 0; i < 26; i++) rem[i]! -= d.counts[bw * 26 + i]!;
    lst = fitsList(d, lst, rem);
  }
  return { score, words };
}
