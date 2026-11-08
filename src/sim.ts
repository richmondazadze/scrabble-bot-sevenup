// Local match simulator mirroring spacetimedb/src/game.ts rules.
import { BAG_COUNTS, LETTER_VALUE, bestPartition, candidates, countsFromString, type Counts, type Dict } from "./engine.js";
import { Brain, mulberry32, type AuctionKind, type Params } from "./brain.js";

export interface Agent {
  name: string;
  start(d: Dict, myId: bigint, players: number, kind: AuctionKind, rack: Counts, seed: number): void;
  // Called when an auction opens. Returns words to play now, then a bid.
  onOpen(auctionId: string, letter: string, bagTotal: number, rack: Counts, balance: number): { words: string[]; bid: number };
  onResult(letter: string, winner: bigint | undefined, paid: number, rack: Counts, balance: number): string[]; // words to play after close
  onWord(bot: bigint, word: string): void;
}

export function rewardOf(w: string): number {
  let base = 0;
  for (const ch of w) base += LETTER_VALUE[ch.charCodeAt(0) - 65]!;
  const n = w.length;
  return n <= 3 ? base : n === 4 ? Math.floor((base * 3) / 2) : n === 5 ? base * 2 : n === 6 ? Math.floor((base * 5) / 2) : base * 3;
}

const L = (c: number) => String.fromCharCode(65 + c);

export class BrainAgent implements Agent {
  b!: Brain;
  constructor(public name: string, public params: Params) {}
  start(d: Dict, myId: bigint, players: number, kind: AuctionKind, rack: Counts, seed: number) {
    this.b = new Brain(d, myId, players, kind, rack, 100, this.params, seed);
  }
  onOpen(auctionId: string, letter: string, bagTotal: number, rack: Counts, balance: number) {
    const b = this.b;
    b.setRack(rack);
    b.balance = balance;
    b.bagTotal = bagTotal;
    b.noteAuction(auctionId, letter);
    const words = b.chooseWords();
    // optimistic bookkeeping so the bid sees the new balance/rack
    for (const w of words) {
      b.applyWord(w, rewardOf(w));
    }
    const bid = b.decideBid(letter);
    return { words, bid };
  }
  onResult(letter: string, winner: bigint | undefined, paid: number, rack: Counts, balance: number) {
    this.b.noteResult(letter, winner, paid);
    return [];
  }
  onWord(bot: bigint, word: string) {
    this.b.noteWord(bot, word);
  }
}

// The server's built-in sim bots.
export class ServerSim implements Agent {
  rng = mulberry32(1);
  d!: Dict;
  constructor(public name: string, public strat: "Cheapskate" | "ValueBidder" | "Aggressive") {}
  start(d: Dict, _id: bigint, _p: number, _k: AuctionKind, _r: Counts, seed: number) {
    this.d = d;
    this.rng = mulberry32(seed);
  }
  onOpen(_a: string, letter: string, _bt: number, _rack: Counts, balance: number) {
    const c = letter.charCodeAt(0) - 65;
    const v = LETTER_VALUE[c]!;
    const vowel = "AEIOU".includes(letter);
    const base = this.strat === "Cheapskate" ? v - 1 : this.strat === "ValueBidder" ? v : v + (vowel ? 4 : 2);
    const jitter = Math.floor(this.rng() * 5) - 2;
    const bid = Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
    return { words: [], bid };
  }
  onResult(_l: string, winner: bigint | undefined, _p: number, rack: Counts, _b: number) {
    return [];
  }
  // server plays longest >=3 right after a sim wins
  simPlay(rack: Counts): string | undefined {
    const cs = candidates(this.d, rack);
    let best = -1;
    for (const w of cs) if (this.d.len[w]! >= 3 && (best < 0 || this.d.len[w]! > this.d.len[best]!)) best = w;
    return best >= 0 ? this.d.words[best] : undefined;
  }
  onWord() {}
}

// Simple strong-ish heuristic: flat bid scaled by letter value, plays 7+,
// dumps at the end. Models K-13-like aggression.
export class FlatAgent implements Agent {
  d!: Dict;
  bagTotal = 99;
  rng = mulberry32(5);
  constructor(public name: string, public base: number, public perPt: number, public playLen = 7, public noise = 0) {}
  start(d: Dict, _id: bigint, _p: number, _k: AuctionKind, _r: Counts, seed: number) {
    this.d = d;
    this.rng = mulberry32(seed + 99);
  }
  onOpen(_a: string, letter: string, bagTotal: number, rack: Counts, balance: number) {
    this.bagTotal = bagTotal;
    const words: string[] = [];
    const part = bestPartition(this.d, rack, undefined, 40);
    for (const w of part.words) if (bagTotal <= 1 || this.d.len[w]! >= this.playLen) words.push(this.d.words[w]!);
    const v = LETTER_VALUE[letter.charCodeAt(0) - 65]!;
    let bid = bagTotal === 0 ? 0 : Math.max(1, Math.floor(this.base + this.perPt * v + (this.rng() * 2 - 1) * this.noise));
    return { words, bid: Math.min(bid, balance) };
  }
  onResult() {
    return [];
  }
  onWord() {}
}

const WI = new WeakMap<Dict, Map<string, number>>();

export interface MatchResult {
  scores: number[];
  names: string[];
  balances: number[];
  leftover: number[];
  wins: number[];
  medPaid: number;
}

export function runMatch(d: Dict, agents: Agent[], kind: AuctionKind, seed: number, verbose = false): MatchResult {
  const rng = mulberry32(seed);
  const n = agents.length;
  const bag = [...BAG_COUNTS];
  let bagTotal = bag.reduce((a, b) => a + b, 0);
  const draw = (): number | undefined => {
    if (bagTotal === 0) return undefined;
    let r = Math.floor(rng() * bagTotal);
    for (let i = 0; i < 26; i++) {
      if (r < bag[i]!) {
        bag[i]!--;
        bagTotal--;
        return i;
      }
      r -= bag[i]!;
    }
    return undefined;
  };
  const racks: Counts[] = agents.map(() => new Uint8Array(26));
  const bal = agents.map(() => 100);
  const score = agents.map(() => 0);
  for (let a = 0; a < n; a++) for (let k = 0; k < 5; k++) racks[a]![draw()!]!++;
  agents.forEach((ag, a) => ag.start(d, BigInt(a), n, kind, racks[a]!, seed * 31 + a));

  let wordIndex = WI.get(d);
  if (!wordIndex) {
    wordIndex = new Map(d.words.map((w, i) => [w, i]));
    WI.set(d, wordIndex);
  }
  const play = (a: number, w: string) => {
    const wi = wordIndex!.get(w);
    if (wi === undefined) return false;
    const need = countsFromString(w);
    for (let i = 0; i < 26; i++) if (need[i]! > racks[a]![i]!) return false;
    for (let i = 0; i < 26; i++) racks[a]![i]! -= need[i]!;
    const r = d.rew[wi]!;
    bal[a]! += r;
    score[a]! += r;
    if (verbose) console.log(`   ${agents[a]!.name} plays ${w} +${r}`);
    agents.forEach((ag) => ag.onWord(BigInt(a), w));
    return true;
  };

  const winsBy = agents.map(() => 0);
  const paidAll: number[] = [];
  let letter = draw();
  let aid = 0;
  while (letter !== undefined) {
    aid++;
    const ch = L(letter);
    const bids: { a: number; amt: number; tie: number }[] = [];
    for (let a = 0; a < n; a++) {
      const { words, bid } = agents[a]!.onOpen(String(aid), ch, bagTotal, new Uint8Array(racks[a]!), bal[a]!);
      for (const w of words) play(a, w);
      const amt = Math.min(Math.floor(bid), bal[a]!);
      if (amt > 0) bids.push({ a, amt, tie: rng() });
    }
    bids.sort((x, y) => y.amt - x.amt || x.tie - y.tie);
    let winner: number | undefined;
    let paid = 0;
    if (bids.length) {
      winner = bids[0]!.a;
      paid = kind === "FirstPrice" ? bids[0]!.amt : bids[1] ? bids[1].amt : Math.min(1, bids[0]!.amt);
      if (bal[winner]! >= paid) {
        bal[winner]! -= paid;
        racks[winner]![letter]!++;
        winsBy[winner]!++;
        paidAll.push(paid);
      } else winner = undefined;
    }
    if (verbose) console.log(`#${aid} ${ch} bag=${bagTotal} -> ${winner === undefined ? "none" : agents[winner]!.name} paid ${paid} bids ${bids.map((b) => agents[b.a]!.name + ":" + b.amt).join(",")}`);
    if (winner !== undefined && agents[winner] instanceof ServerSim) {
      const w = (agents[winner] as ServerSim).simPlay(racks[winner]!);
      if (w) play(winner, w);
    }
    for (let a = 0; a < n; a++) {
      const ws = agents[a]!.onResult(ch, winner === undefined ? undefined : BigInt(winner), paid, new Uint8Array(racks[a]!), bal[a]!);
      for (const w of ws) play(a, w);
    }
    letter = draw();
  }
  return { scores: score, names: agents.map((a) => a.name), balances: bal, leftover: racks.map((r) => r.reduce((x, y) => x + y, 0)), wins: winsBy, medPaid: paidAll.sort((a, b) => a - b)[paidAll.length >> 1] ?? 0 };
}
