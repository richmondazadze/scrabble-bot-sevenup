// ScrabbleBot live client.
//   First run:  BOT_NAME=<name> BOT_TOKEN=<token from /team> npm start
//   Later:      BOT_NAME=<name> npm start            (token saved to .token-<name>)
//   Tournament: BOT_NAME=<name> TOURNAMENT_ID=<id> npm start
import { DbConnection, tables, type ErrorContext } from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDict, type Counts } from "./engine.js";
import { Brain, DEFAULT_PARAMS, type AuctionKind, type Params } from "./brain.js";
import { rewardOf } from "./sim.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN;
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const NO_LOBBY = process.env.NO_LOBBY === "1"; // tournament-only: don't queue for lobby games
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);
const PARAMS: Params = { ...DEFAULT_PARAMS, ...(process.env.PARAMS ? JSON.parse(process.env.PARAMS) : {}) };

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), `[${BOT_NAME}]`, ...a);

const DICT = loadDict(path.join(HERE, "..", "wordlist.txt"));
log(`dictionary: ${DICT.n} anagram classes`);

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
let participantsReady = false;
let maxKnownMatchId = -1n; // matches at or below this existed at startup

interface MatchCtx {
  id: bigint;
  brain: Brain | null;
  bidSent: Set<bigint>;
  pending: string[]; // words submitted, not yet confirmed by word_play
  subscribed: boolean;
  applied: boolean;
  since: number;
  ended: boolean;
  handle?: { unsubscribe(): void };
}
const matches = new Map<string, MatchCtx>();
let lastAuctionAt = Date.now();

function rackFor(conn: DbConnection, matchId: bigint): Counts {
  const c = new Uint8Array(26);
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    const i = h.letter.charCodeAt(0) - 65;
    if (i >= 0 && i < 26) c[i] = Math.min(255, c[i]! + h.count);
  }
  return c;
}

function myParticipant(conn: DbConnection, matchId: bigint) {
  for (const p of conn.db.matchParticipant.iter()) if (p.matchId === matchId && p.botId === myBotId) return p;
  return undefined;
}

function playersIn(conn: DbConnection, matchId: bigint): number {
  let n = 0;
  for (const p of conn.db.matchParticipant.iter()) if (p.matchId === matchId) n++;
  return n;
}

// Rack as the server will see it once our in-flight words land.
function effectiveRack(conn: DbConnection, m: MatchCtx): Counts {
  const c = rackFor(conn, m.id);
  for (const w of m.pending) for (const ch of w) {
    const i = ch.charCodeAt(0) - 65;
    if (c[i]! > 0) c[i]!--;
  }
  return c;
}

function ensureBrain(conn: DbConnection, m: MatchCtx): Brain | null {
  if (m.brain) return m.brain;
  const st = conn.db.matchState.id.find(m.id);
  const me = myParticipant(conn, m.id);
  if (!st || !me || myBotId === null) return null;
  const kind: AuctionKind = st.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey";
  const players = playersIn(conn, m.id);
  m.brain = new Brain(DICT, myBotId, players, kind, rackFor(conn, m.id), Number(me.balance), PARAMS, Number(m.id % 100000n));
  // Replay history we may have missed (late start / reconnect).
  for (const a of conn.db.auction.iter()) if (a.matchId === m.id) m.brain.noteAuction(String(a.id), a.letter);
  for (const r of conn.db.auctionResult.iter())
    if (r.matchId === m.id) m.brain.noteResult(r.letter, r.winnerBotId ?? undefined, Number(r.paid));
  for (const w of conn.db.wordPlay.iter()) if (w.matchId === m.id) m.brain.noteWord(w.botId, w.word);
  log(`match ${m.id}: ${players} players, ${kind}, rack ${[...rackFor(conn, m.id)].map((n, i) => String.fromCharCode(65 + i).repeat(n)).join("")}`);
  return m.brain;
}

function failure(m: MatchCtx | null, what: string, word?: string) {
  return (err: unknown) => {
    if (m && word) {
      const i = m.pending.indexOf(word);
      if (i >= 0) m.pending.splice(i, 1);
    }
    log(`${what} failed: ${err instanceof Error ? err.message : err}`);
  };
}

// Core turn: on each open auction, cash words, then bid.
function act(conn: DbConnection, m: MatchCtx, auctionId: bigint | null, letter: string | null) {
  const st = conn.db.matchState.id.find(m.id);
  if (!st || st.status.tag !== "Running") return;
  const b = ensureBrain(conn, m);
  const me = myParticipant(conn, m.id);
  if (!b || !me) return;
  const t0 = performance.now();
  b.bagTotal = st.bagTotal;
  b.setRack(effectiveRack(conn, m));
  let bal = Number(me.balance);
  for (const w of m.pending) bal += rewardOf(w);
  b.balance = bal;
  b.score = Number(me.score);

  const words = b.chooseWords();
  for (const w of words) {
    m.pending.push(w);
    b.applyWord(w, rewardOf(w));
    conn.reducers.submitWord({ matchId: m.id, word: w }).catch(failure(m, `word ${w}`, w));
  }
  if (words.length) log(`match ${m.id}: play ${words.join(" ")} (bag ${st.bagTotal})`);

  if (auctionId !== null && letter !== null && !m.bidSent.has(auctionId)) {
    m.bidSent.add(auctionId);
    let bid = 0;
    try {
      bid = b.decideBid(letter, String(auctionId));
    } catch (e) {
      log("decideBid error", e);
    }
    bid = Math.max(0, Math.min(Math.floor(bid), b.balance));
    const ms = (performance.now() - t0).toFixed(0);
    if (bid > 0) conn.reducers.submitBid({ auctionId, amount: BigInt(bid) }).catch(failure(null, `bid ${auctionId}`));
    log(`match ${m.id}: '${letter}' mv=${b.lastMv.toFixed(1)} mkt=${b.marketPrice().toFixed(0)} bid ${bid} bal ${b.balance} bag ${st.bagTotal} (${ms}ms)`);
  }
}

function subscribeMatch(conn: DbConnection, matchId: bigint) {
  const key = String(matchId);
  if (matches.get(key)?.subscribed) return;
  const m: MatchCtx = matches.get(key) ?? { id: matchId, brain: null, bidSent: new Set(), pending: [], subscribed: false, applied: false, since: Date.now(), ended: false };
  m.subscribed = true;
  matches.set(key, m);
  lastAuctionAt = Date.now(); // give the new subscription time before the watchdog judges
  m.handle = conn
    .subscriptionBuilder()
    .onApplied(() => {
      m.applied = true;
      const st = conn.db.matchState.id.find(matchId);
      if (!st || st.status.tag !== "Running") {
        m.ended = true;
        return;
      }
      ensureBrain(conn, m);
      const open = [...conn.db.auction.iter()].find((a) => a.matchId === matchId && a.status.tag === "Open");
      act(conn, m, open?.id ?? null, open?.letter ?? null);
    })
    .onError((_c: ErrorContext) => log(`subscription error for match ${matchId}`))
    .subscribe([
      tables.matchState.where((r) => r.id.eq(matchId)),
      tables.matchParticipant.where((r) => r.matchId.eq(matchId)),
      tables.auction.where((r) => r.matchId.eq(matchId)),
      tables.auctionResult.where((r) => r.matchId.eq(matchId)),
      tables.wordPlay.where((r) => r.matchId.eq(matchId)),
    ]);
}

function inRunningMatch(conn: DbConnection): boolean {
  for (const m of matches.values()) {
    if (m.ended) continue;
    const st = conn.db.matchState.id.find(m.id);
    if (st?.status.tag === "Running") return true;
    if (!st && !m.applied && Date.now() - m.since < 15000) return true; // still loading
  }
  return false;
}

let lastJoin = 0;
const registered = new Set<string>();

// Auto-register for any tournament open for registration; while we're an
// entrant of one that hasn't ended, stay out of the lobby.
function tournamentHold(conn: DbConnection): boolean {
  if (myBotId === null) return false;
  for (const t of conn.db.tournament.iter()) {
    const tag = t.status.tag;
    if (tag === "Ended" || tag === "ForceEnded") continue;
    const entrant = [...conn.db.tournamentEntry.iter()].some((e) => e.tournamentId === t.id && e.botId === myBotId);
    if (entrant) return true;
  }
  return false;
}

function autoRegister(conn: DbConnection) {
  if (myBotId === null || process.env.NO_AUTO_REGISTER === "1") return;
  for (const t of conn.db.tournament.iter()) {
    if (t.status.tag !== "Registration") continue;
    const k = String(t.id);
    if (registered.has(k)) continue;
    registered.add(k);
    conn.reducers
      .registerForTournament({ tournamentId: t.id })
      .then(() => log(`*** registered for tournament ${t.id} (${t.auctionType.tag}, tables of ${t.matchSize}) ***`))
      .catch((e: unknown) => {
        registered.delete(k);
        log(`register for tournament ${t.id} failed: ${e instanceof Error ? e.message : e}`);
      });
  }
}
function joinLobby(conn: DbConnection) {
  if (NO_LOBBY || myBotId === null) return;
  if (inRunningMatch(conn)) return;
  if (tournamentHold(conn)) return;
  if (Date.now() - lastJoin < 3000) return;
  lastJoin = Date.now();
  log("joining lobby");
  conn.reducers.joinLobby({}).catch(failure(null, "join lobby"));
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  fs.writeFileSync(TOKEN_PATH, token);
  log(`connected as ${identity.toHexString().slice(0, 16)}…`);

  // Table callbacks (filtered to our matches).
  conn.db.matchParticipant.onInsert((_c, p) => {
    if (participantsReady && myBotId !== null && p.botId === myBotId && p.matchId > maxKnownMatchId) {
      const st = conn.db.matchState.id.find(p.matchId);
      if (!matches.has(String(p.matchId)) && (!st || st.status.tag === "Running")) {
        log(`seated in match ${p.matchId}`);
        subscribeMatch(conn, p.matchId);
      }
    }
  });
  conn.db.auction.onInsert((_c, a) => {
    const m = matches.get(String(a.matchId));
    if (m) lastAuctionAt = Date.now();
    if (!m || a.status.tag !== "Open") return;
    act(conn, m, a.id, a.letter);
  });
  conn.db.auctionResult.onInsert((_c, r) => {
    const m = matches.get(String(r.matchId));
    if (!m?.brain) return;
    m.brain.noteResult(r.letter, r.winnerBotId ?? undefined, Number(r.paid));
    if (r.winnerBotId === myBotId) log(`match ${r.matchId}: won '${r.letter}' paid ${r.paid}`);
  });
  conn.db.wordPlay.onInsert((_c, w) => {
    const m = matches.get(String(w.matchId));
    if (!m) return;
    if (w.botId === myBotId) {
      const i = m.pending.indexOf(w.word);
      if (i >= 0) m.pending.splice(i, 1);
      log(`match ${w.matchId}: scored ${w.word} +${w.totalReward}`);
    } else m.brain?.noteWord(w.botId, w.word);
  });
  conn.db.matchState.onUpdate((_c, old, neu) => {
    const m = matches.get(String(neu.id));
    if (!m) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      m.ended = true;
      const ps = [...conn.db.matchParticipant.iter()].filter((p) => p.matchId === neu.id).sort((a, b) => Number(b.score - a.score));
      const place = ps.findIndex((p) => p.botId === myBotId) + 1;
      log(`match ${neu.id} ENDED: place ${place}/${ps.length} — ${ps.map((p) => `${conn.db.bot.id.find(p.botId)?.name ?? p.botId}:${p.score}`).join(" ")}`);
      setTimeout(() => joinLobby(conn), 500);
      setTimeout(() => {
        try {
          m.handle?.unsubscribe();
        } catch {}
        m.brain = null;
      }, 5000);
    }
  });

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      const cred = conn.db.botCredential.identity.find(identity);
      myBotId = cred?.botId ?? null;
      if (myBotId === null) {
        log("No bot for this token — generate a fresh one on /team and pass BOT_TOKEN");
        process.exit(1);
      }
      log(`acting as bot '${conn.db.bot.id.find(myBotId)?.name ?? "?"}' (id ${myBotId})`);
      const me = myBotId;
      conn
        .subscriptionBuilder()
        .onApplied(() => {
          // Resume any match still running (pick the newest few).
          const mine = [...conn.db.matchParticipant.iter()].filter((p) => p.botId === me).map((p) => p.matchId).sort((a, b) => (a > b ? -1 : 1));
          maxKnownMatchId = mine[0] ?? -1n;
          participantsReady = true;
          for (const id of mine.slice(0, 2)) subscribeMatch(conn, id);
          if (TOURNAMENT_ID) {
            conn.reducers
              .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
              .then(() => log(`registered for tournament ${TOURNAMENT_ID}`))
              .catch(failure(null, `register for tournament ${TOURNAMENT_ID}`));
          }
          autoRegister(conn);
          conn.db.tournament.onInsert(() => autoRegister(conn));
          conn.db.tournament.onUpdate((_c, _o, t) => {
            autoRegister(conn);
            log(`tournament ${t.id} status: ${t.status.tag} round ${t.currentRound}`);
          });
          setTimeout(() => joinLobby(conn), 1500);
          setInterval(() => joinLobby(conn), 10000);
          // Watchdog: in a running match, auctions arrive every ~1s. If none
          // for 20s the connection is probably dead: exit so run.sh restarts.
          lastAuctionAt = Date.now();
          setInterval(() => {
            if (inRunningMatch(conn) && Date.now() - lastAuctionAt > 20000) {
              log("watchdog: no auctions for 20s in a running match — restarting");
              process.exit(4);
            }
          }, 5000);
        })
        .subscribe([
          tables.matchParticipant.where((r) => r.botId.eq(me)),
          tables.tournament,
          tables.tournamentEntry.where((r) => r.botId.eq(me)),
        ]);
    })
    .subscribe([tables.botCredential, tables.bot, tables.myRack]);
}

DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withToken(BOT_TOKEN ?? (fs.existsSync(TOKEN_PATH) ? fs.readFileSync(TOKEN_PATH, "utf8").trim() : undefined))
  .onConnect(onConnect)
  .onConnectError((_c: ErrorContext, err: Error) => {
    log("connect error:", err.message);
    process.exit(2);
  })
  .onDisconnect(() => {
    log("disconnected — exiting so the run loop restarts us");
    process.exit(3);
  })
  .build();
