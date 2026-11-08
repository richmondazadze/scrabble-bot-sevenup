// The bot's decision-making for one match. Pure logic: fed events, returns
// bids and words. Used identically by the live client and the simulator.
import {
  BAG_COUNTS,
  bestPartition,
  candidates,
  greedyPartition,
  type Counts,
  type Dict,
} from "./engine.js";

export type AuctionKind = "Vickrey" | "FirstPrice";

export interface Params {
  lambda: number; // coins per point of marginal value at reference wealth
  gamma: number; // wealth elasticity of bids
  refWPW: number; // reference coins per expected future win
  shareMul: number; // multiplier on 1/players for expected future win share
  samples: number; // Monte Carlo samples for marginal value
  playLen: number; // mid-game: cash words at least this long
  lowBal: number; // below this balance, cash words >= liqLen
  liqLen: number;
  dumpAt: number; // when bagTotal <= dumpAt, play everything
  minBid: number; // floor bid when mv > 0
  fpShade: number; // first-price: fallback shading factor
  maxFrac: number; // max fraction of balance on one tile (before final rounds)
  mkt: number; // market-relative bid multiplier (0 = off)
  mktAlpha: number; // exponent on mv/mvAvg
  mktPrior: number; // prior market price before data
  earlyMul: number; // bid multiplier during the early phase
  earlyFrac: number; // fraction of auctions considered early
  lateN: number; // when bagTotal <= lateN, spend down the balance
  lateMul: number;
  denial: number; // extra bid weight for small tables: lambda*(1+denial/(n-1))/(1+denial/5)
}

export const DEFAULT_PARAMS: Params = {
  lambda: 2.4,
  gamma: 1.0,
  refWPW: 12,
  shareMul: 1.0,
  samples: 24,
  playLen: 7,
  lowBal: 12,
  liqLen: 5,
  dumpAt: 1,
  minBid: 1,
  fpShade: 0.7,
  maxFrac: 1.0,
  mkt: 1.0,
  mktAlpha: 0.8,
  mktPrior: 12,
  earlyMul: 0.85,
  earlyFrac: 0.35,
  lateN: 12,
  lateMul: 1.0,
  denial: 4,
};

export let MV_BUDGET_MS = 120;
export function setMvBudget(ms: number) {
  MV_BUDGET_MS = ms;
}

const idx = (ch: string) => ch.charCodeAt(0) - 65;

// Deterministic, seedable RNG so sims are reproducible.
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function group(c: number): number {
  // Buckets of letters that tend to clear at similar prices.
  const ch = String.fromCharCode(65 + c);
  if ("AEIOU".includes(ch)) return 0;
  if ("LNSTR".includes(ch)) return 1;
  if ("DG".includes(ch)) return 2;
  if ("BCMP".includes(ch)) return 3;
  if ("FHVWY".includes(ch)) return 4;
  return 5; // K J X Q Z
}

export class Brain {
  readonly p: Params;
  readonly d: Dict;
  myId: bigint;
  players: number;
  kind: AuctionKind;
  rack: Counts = new Uint8Array(26);
  balance = 100;
  score = 0;
  bagTotal = 0; // tiles still in bag (after the current auction's draw)
  private bagStart = -1;
  private initial: Counts = new Uint8Array(26);
  private auctioned: Counts = new Uint8Array(26); // every auctioned letter seen
  private oppWon = new Map<string, Counts>();
  private oppPlayed = new Map<string, Counts>();
  private seenAuctions = new Set<string>();
  private wins = 0;
  private auctionsClosed = 0;
  // first-price: winning bids by letter group
  private paidHist: number[][] = [[], [], [], [], [], []];
  private allPaid: number[] = [];
  private mvAvg = 5;
  private mvN = 0;
  private rng: () => number;
  lastMv = 0;

  constructor(
    d: Dict,
    myId: bigint,
    players: number,
    kind: AuctionKind,
    rack: Counts,
    balance: number,
    p: Params = DEFAULT_PARAMS,
    seed = 12345,
  ) {
    this.d = d;
    this.p = p;
    this.myId = myId;
    this.players = Math.max(2, players);
    this.kind = kind;
    this.rack = new Uint8Array(rack);
    this.initial = new Uint8Array(rack);
    this.balance = balance;
    this.rng = mulberry32(seed);
  }

  setRack(rack: Counts) {
    this.rack = new Uint8Array(rack);
  }

  // ----- event intake -----

  noteAuction(auctionId: string, letter: string) {
    if (this.seenAuctions.has(auctionId)) return;
    this.seenAuctions.add(auctionId);
    this.auctioned[idx(letter)]!++;
  }

  noteResult(letter: string, winner: bigint | undefined, paid: number) {
    this.auctionsClosed++;
    if (winner === undefined) return;
    if (paid > 0) this.allPaid.push(paid);
    if (winner === this.myId) {
      this.wins++;
      return;
    }
    const k = String(winner);
    const c = this.oppWon.get(k) ?? new Uint8Array(26);
    c[idx(letter)]!++;
    this.oppWon.set(k, c);
    if (this.kind === "FirstPrice") this.paidHist[group(idx(letter))]!.push(paid);
  }

  noteWord(bot: bigint, word: string) {
    if (bot === this.myId) return;
    const k = String(bot);
    const c = this.oppPlayed.get(k) ?? new Uint8Array(26);
    for (const ch of word) c[idx(ch)]!++;
    this.oppPlayed.set(k, c);
  }

  // Tiles not known to be elsewhere: candidates for future draws.
  pool(): Counts {
    const pool = new Uint8Array(26);
    for (let i = 0; i < 26; i++) {
      let out = this.auctioned[i]! + this.initial[i]!;
      for (const [k, played] of this.oppPlayed) {
        const won = this.oppWon.get(k)?.[i] ?? 0;
        out += Math.max(0, played[i]! - won);
      }
      pool[i] = Math.max(0, BAG_COUNTS[i]! - out);
    }
    return pool;
  }

  // ----- valuation -----

  expectedFutureWins(): number {
    const usable = Math.max(0, this.bagTotal - 1); // last auction's tile is dead
    let share = 1 / this.players;
    if (this.auctionsClosed >= 8) {
      // blend in observed win rate
      const obs = this.wins / this.auctionsClosed;
      share = 0.5 * share + 0.5 * obs;
    }
    return usable * Math.min(1, share * this.p.shareMul);
  }

  // Marginal value (points) of adding tile `c` to the rack.
  marginalValue(c: number): number {
    if (this.bagTotal === 0) return 0; // last auction: can't be played
    const K = Math.round(this.expectedFutureWins());
    const with_ = new Uint8Array(this.rack);
    with_[c]!++;
    if (K === 0) {
      const a = bestPartition(this.d, with_, undefined, 40).score;
      const b = bestPartition(this.d, this.rack, undefined, 40).score;
      return Math.max(0, a - b);
    }
    const pool = this.pool();
    if (pool[c]! > 0) pool[c]!--;
    const flat: number[] = [];
    for (let i = 0; i < 26; i++) for (let k = 0; k < pool[i]!; k++) flat.push(i);
    const kk = Math.min(K, flat.length);
    let sum = 0;
    const S = this.p.samples;
    const deadline = performance.now() + MV_BUDGET_MS;
    let done = 0;
    for (let s = 0; s < S; s++) {
      if (s >= 4 && performance.now() > deadline) break;
      // partial Fisher-Yates
      for (let j = 0; j < kk; j++) {
        const r = j + Math.floor(this.rng() * (flat.length - j));
        const t = flat[j]!;
        flat[j] = flat[r]!;
        flat[r] = t;
      }
      const base = new Uint8Array(this.rack);
      for (let j = 0; j < kk; j++) base[flat[j]!]!++;
      const cand1 = candidates(this.d, (base[c]!++, base));
      const v1 = greedyPartition(this.d, base, cand1).score;
      base[c]!--;
      const v0 = greedyPartition(this.d, base).score;
      sum += v1 - v0;
      done++;
    }
    return Math.max(0, sum / Math.max(1, done));
  }

  // ----- decisions -----

  decideBid(letter: string, auctionId?: string): number {
    if (auctionId) this.noteAuction(auctionId, letter);
    const c = idx(letter);
    const mv = this.marginalValue(c);
    this.lastMv = mv;
    if (mv <= 0 || this.balance <= 0) return 0;
    const ew = this.expectedFutureWins();
    const wpw = this.balance / (ew + 1);
    const tableAdj = (1 + this.p.denial / (this.players - 1)) / (1 + this.p.denial / 5);
    const lam = this.p.lambda * tableAdj * Math.pow(Math.max(0.05, wpw / this.p.refWPW), this.p.gamma);
    let bid = mv * lam;
    // Market-relative bid: price this tile against what tiles actually
    // clear at, scaled by how it compares with our typical tile value.
    if (this.p.mkt > 0) {
      const mk = this.marketPrice();
      const rel = Math.pow(mv / Math.max(1, this.mvAvg), this.p.mktAlpha);
      // pacing: can we afford market prices for our expected wins?
      const pace = Math.min(1.5, Math.max(0.3, wpw / Math.max(1, mk)));
      const mb = mk * rel * this.p.mkt * tableAdj * pace;
      bid = Math.max(bid, mb);
    }
    // Late game: leftover coins are worthless at the end, so spread the
    // balance over the wins we can still use, weighted by tile value.
    if (this.bagTotal <= this.p.lateN && mv >= 1) {
      const share = Math.min(1.5, mv / Math.max(1, this.mvAvg));
      bid = Math.max(bid, ((this.balance / Math.max(1, ew)) * share * this.p.lateMul));
    }
    this.mvN++;
    this.mvAvg += (mv - this.mvAvg) / Math.min(this.mvN, 20);
    if (this.bagStart < 0) this.bagStart = this.bagTotal + 1;
    const progress = 1 - this.bagTotal / Math.max(1, this.bagStart);
    if (progress < this.p.earlyFrac) bid *= this.p.earlyMul;
    if (this.kind === "FirstPrice") bid = this.shadeFirstPrice(c, bid);
    const endgame = this.bagTotal <= 3;
    const cap = endgame ? this.balance : Math.max(this.p.minBid, this.balance * this.p.maxFrac);
    bid = Math.min(bid, cap, this.balance);
    bid = Math.max(this.p.minBid, Math.floor(bid));
    return Math.min(bid, this.balance);
  }

  marketPrice(): number {
    const h = this.allPaid.slice(-24);
    if (h.length < 4) return this.p.mktPrior;
    const sorted = [...h].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1]!;
    // shrink toward prior while data is thin
    const w = Math.min(1, h.length / 12);
    return w * med + (1 - w) * this.p.mktPrior;
  }

  private shadeFirstPrice(c: number, value: number): number {
    const h = this.paidHist[group(c)]!;
    const all = this.paidHist.flat();
    const hist = h.length >= 4 ? h : all.length >= 6 ? all : null;
    if (!hist) return value * this.p.fpShade;
    // Maximise P(win | b) * (value - b), P from empirical winning bids.
    const sorted = [...hist].sort((a, b) => a - b);
    let bestB = 0;
    let bestU = 0;
    const top = Math.floor(value);
    for (let b = 1; b <= top; b++) {
      // fraction of winning bids strictly below b (+ half of ties)
      let lo = 0;
      let eq = 0;
      for (const x of sorted) {
        if (x < b) lo++;
        else if (x === b) eq++;
      }
      const pw = (lo + 0.5 * eq + 0.5) / (sorted.length + 1);
      const u = pw * (value - b);
      if (u > bestU) {
        bestU = u;
        bestB = b;
      }
    }
    return bestB;
  }

  // Words to play right now given the current rack and state.
  chooseWords(): string[] {
    const total = this.rack.reduce((a, b) => a + b, 0);
    if (total < 2) return [];
    const dump = this.bagTotal <= this.p.dumpAt;
    const part = bestPartition(this.d, this.rack, undefined, dump ? 150 : 60);
    if (dump) return part.words.map((w) => this.d.words[w]!);
    const out: string[] = [];
    for (const w of part.words) if (this.d.len[w]! >= this.p.playLen) out.push(this.d.words[w]!);
    if (out.length === 0 && this.balance < this.p.lowBal) {
      // need liquidity: best word of decent length from the partition
      let bw = -1;
      for (const w of part.words)
        if (this.d.len[w]! >= this.p.liqLen && (bw < 0 || this.d.rew[w]! > this.d.rew[bw]!)) bw = w;
      if (bw >= 0) out.push(this.d.words[bw]!);
    }
    return out;
  }

  // Apply a word we played (sim + optimistic live bookkeeping).
  applyWord(word: string, rew: number) {
    for (const ch of word) this.rack[idx(ch)]!--;
    this.balance += rew;
    this.score += rew;
  }
}
