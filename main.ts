import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const ENV = {
  PROMPT_FILE: 'MAKEFUN_PROMPT_FILE',
  ENV_URL: 'MAKEFUN_ENV_URL',
  TRIAL_SEED: 'MAKEFUN_TRIAL_SEED',
};

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class Rng {
  #s;

  constructor(seed, label = '') {
    const h = createHash('sha256')
      .update('agent-fun/agent/rng/v1', 'utf8')
      .update('\0')
      .update(seed, 'utf8')
      .update('\0')
      .update(label, 'utf8')
      .digest();
    let s = [h.readBigUInt64BE(0), h.readBigUInt64BE(8), h.readBigUInt64BE(16), h.readBigUInt64BE(24)];
    if (s.every((w) => w === 0n)) s[0] = 1n;
    this.#s = s;
  }

  nextU64() {
    const [s0, s1, s2, s3] = this.#s;
    const MASK64 = (1n << 64n) - 1n;
    const rotl = (x, k) => ((x << k) | (x >> (64n - k))) & MASK64;
    const result = (rotl((s1 * 5n) & MASK64, 7n) * 9n) & MASK64;
    const t = (s1 << 17n) & MASK64;
    const a2 = s2 ^ s0;
    const a3 = s3 ^ s1;
    this.#s = [s0 ^ a3, s1 ^ a2, a2 ^ t, rotl(a3, 45n)];
    return result;
  }

  int(min, max) {
    const span = BigInt(max) - BigInt(min) + 1n;
    const TWO64 = 1n << 64n;
    const limit = TWO64 - (TWO64 % span);
    for (;;) {
      const x = this.nextU64();
      if (x < limit) return Number(BigInt(min) + (x % span));
    }
  }

  pick(items) {
    return items[this.int(0, items.length - 1)];
  }
}

const games = new Map();

function foldStatement(text) {
  return text.replace(/[\t\n\v\f\r\u0085  ]+/g, ' ').replace(/\p{Cc}/gu, '').trim();
}

function fallbackFor(p) {
  return p.decision === 'speak' ? { game: p.game, decision: 'speak', pass: true } : { game: p.game, decision: p.decision, target: null };
}

function jsonObjects(text) {
  const out = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const v = JSON.parse(text.slice(start, i + 1));
            if (isRecord(v)) out.push(v);
          } catch {}
          break;
        }
      }
    }
  }
  return out;
}

function parseReply(text, p) {
  const key = p.decision === 'speak' ? 'say' : 'target';
  const found = jsonObjects(text).filter((o) => key in o);
  if (found.length === 0) return { ok: false, act: fallbackFor(p) };
  const value = found[found.length - 1][key];
  if (p.decision === 'speak') {
    if (typeof value !== 'string') return { ok: value === null, act: fallbackFor(p) };
    const folded = foldStatement(value);
    if (folded === '') return { ok: true, act: fallbackFor(p) };
    const max = p.max_chars ?? 500;
    const cut = [...folded].length > max ? [...folded].slice(0, max).join('').trim() : folded;
    return { ok: true, act: { game: p.game, decision: 'speak', text: cut } };
  }
  const seat = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  const target = typeof seat === 'number' && (p.options ?? []).includes(seat) ? seat : null;
  return { ok: value === null || target !== null, act: { game: p.game, decision: p.decision, target } };
}

function replyText(body) {
  const content = isRecord(body) ? body.content : undefined;
  if (!Array.isArray(content)) return '';
  return content.flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');
}

function getOrCreateGame(view, game) {
  if (!games.has(game)) {
    const state = {
      game,
      role: view.you.role,
      partner: view.you.partner?.seat ?? null,
      lastProtected: null,
      inspections: new Map(),
      knownWolves: new Set(),
      knownVillagers: new Set(),
      daysSeen: new Set(),
    };
    games.set(game, state);
  }
  return games.get(game);
}

function getAlivePlayers(view) {
  return view.players.filter((p) => p.alive).map((p) => p.seat);
}

function getNonWolves(view) {
  return view.players.filter((p) => p.alive && (view.you.role !== 'werewolf' || view.you.partner?.seat !== p.seat)).map((p) => p.seat);
}

function makeWerewolfKill(view, state, rng, options) {
  const aliveNonWolves = getNonWolves(view);
  const validOptions = options.filter((o) => aliveNonWolves.includes(o));
  if (validOptions.length === 0) return null;

  let reveal = undefined;
  for (const entry of view.log) {
    if (entry.kind === 'exile' && typeof entry.role === 'string') {
      reveal = { seat: entry.seat, role: entry.role };
    }
  }

  let target = validOptions[0];
  if (reveal?.role === 'seer') {
    const seersInOptions = validOptions.filter((s) => view.players.find((p) => p.seat === s && p.alive));
    if (seersInOptions.length > 0) target = seersInOptions[0];
  } else {
    const suspicious = validOptions.filter((s) => {
      const p = view.players.find((pl) => pl.seat === s);
      return p && !state.knownVillagers.has(s);
    });
    if (suspicious.length > 0) target = rng.pick(suspicious);
  }

  return target;
}

function makeWerewolfVote(view, state, rng, options) {
  if (!state.partner || !view.players.find((p) => p.seat === state.partner && p.alive)) return rng.pick(options);

  for (const entry of view.log) {
    if (entry.kind === 'vote' && entry.seat === state.partner && typeof entry.vote === 'number') {
      if (options.includes(entry.vote)) return entry.vote;
    }
  }

  const suspicious = options.filter((o) => o !== state.partner);
  return suspicious.length > 0 ? rng.pick(suspicious) : null;
}

function makeSeerInspect(view, state, rng, options) {
  const uninspected = options.filter((o) => !state.inspections.has(o));
  if (uninspected.length > 0) return rng.pick(uninspected);
  return null;
}

function makeSeerStatement(view, state) {
  if (view.day === 1) return '';

  const revealed = [];
  for (const entry of view.log) {
    if (entry.kind === 'exile' && typeof entry.role === 'string' && typeof entry.seat === 'number') {
      revealed.push(entry.seat);
    }
  }

  let certainWolf = undefined;
  for (const [seat, isWolf] of state.inspections) {
    if (isWolf && !revealed.includes(seat)) {
      certainWolf = seat;
      break;
    }
  }

  if (certainWolf) {
    const p = view.players.find((pl) => pl.seat === certainWolf && pl.alive);
    if (p) return `I inspected seat ${certainWolf} (${p.name}) and they are a werewolf. Vote them out.`;
  }

  return '';
}

function makeDoctorProtect(view, state, rng, options) {
  let revealer = undefined;
  for (const entry of view.log) {
    if (entry.kind === 'exile' && entry.seat && typeof entry.role === 'string' && entry.role === 'seer') {
      revealer = entry.seat;
    }
  }

  if (revealer && options.includes(revealer)) return revealer;

  const suspicious = options.filter((o) => {
    if (o === state.lastProtected) return false;
    return !state.knownVillagers.has(o);
  });

  if (suspicious.length > 0) return rng.pick(suspicious);
  return null;
}

function makeVillagerStatement(view) {
  const voted = new Map();
  let lastKill = undefined;

  for (const entry of view.log) {
    if (entry.kind === 'vote' && typeof entry.seat === 'number' && typeof entry.vote === 'number') {
      voted.set(entry.vote, (voted.get(entry.vote) ?? 0) + 1);
    }
    if (entry.kind === 'death' && typeof entry.seat === 'number') {
      lastKill = entry.seat;
    }
  }

  const mostVoted = [...voted.entries()].sort((a, b) => b[1] - a[1])[0];
  if (mostVoted && mostVoted[1] >= 2) {
    const p = view.players.find((pl) => pl.seat === mostVoted[0]);
    if (p) return `Seat ${mostVoted[0]} (${p.name}) received multiple votes. Suspicious.`;
  }

  if (lastKill) {
    const p = view.players.find((pl) => pl.seat === lastKill);
    if (p && p.role) return `Night killed: ${p.name}. Role was ${p.role}.`;
  }

  return '';
}

async function decide(p, rng) {
  const view = p.view;
  const state = getOrCreateGame(view, p.game);
  state.daysSeen.add(view.day);

  let say = '';
  let target = null;

  switch (p.decision) {
    case 'speak': {
      const max = p.max_chars ?? 500;
      if (state.role === 'werewolf') {
        say = '';
      } else if (state.role === 'seer') {
        say = makeSeerStatement(view, state);
      } else if (state.role === 'doctor') {
        say = '';
      } else {
        say = makeVillagerStatement(view);
      }
      say = foldStatement(say);
      if ([...say].length > max) {
        say = [...say].slice(0, max).join('').trim();
      }
      return { game: p.game, decision: 'speak', text: say || null, pass: !say };
    }

    case 'kill': {
      const opts = p.options ?? [];
      target = makeWerewolfKill(view, state, rng, opts);
      return { game: p.game, decision: 'kill', target };
    }

    case 'protect': {
      const opts = p.options ?? [];
      target = makeDoctorProtect(view, state, rng, opts);
      if (target) state.lastProtected = target;
      return { game: p.game, decision: 'protect', target };
    }

    case 'inspect': {
      const opts = p.options ?? [];
      target = makeSeerInspect(view, state, rng, opts);
      if (target && typeof target === 'number') {
        const isWolf = view.players.some((p) => p.seat === target && p.role === 'werewolf');
        state.inspections.set(target, isWolf);
      }
      return { game: p.game, decision: 'inspect', target };
    }

    case 'vote': {
      const opts = p.options ?? [];
      if (state.role === 'werewolf') {
        target = makeWerewolfVote(view, state, rng, opts);
      } else {
        const voted = new Map();
        for (const entry of view.log) {
          if (entry.kind === 'vote' && typeof entry.seat === 'number' && typeof entry.vote === 'number') {
            voted.set(entry.vote, (voted.get(entry.vote) ?? 0) + 1);
          }
        }

        let mostVoted = [...voted.entries()].sort((a, b) => b[1] - a[1])[0];
        if (mostVoted && opts.includes(mostVoted[0])) {
          target = mostVoted[0];
        } else {
          target = rng.pick(opts);
        }
      }
      return { game: p.game, decision: 'vote', target };
    }
  }
}

async function run() {
  const env = process.env;
  const envUrl = (env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  const promptFile = env[ENV.PROMPT_FILE] ?? '';

  if (!envUrl || !promptFile) throw new Error('MAKEFUN_ENV_URL and MAKEFUN_PROMPT_FILE are required');

  const seed = env[ENV.TRIAL_SEED] ?? '';
  if (!seed) throw new Error('MAKEFUN_TRIAL_SEED is required');

  const rng = new Rng(seed);

  const envPost = async (path, body) => {
    const res = await fetch(`${envUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, body: parsed };
  };

  const keyOf = (p) => `${p.game}:${p.decision}:${p.view.log.length}`;
  const inFlight = new Map();
  const started = new Set();
  const CONCURRENCY = 10;

  for (;;) {
    const r = await envPost('/observe', {});
    if (r.status !== 200 || !isRecord(r.body)) throw new Error(`POST /observe answered ${r.status}`);
    const obs = r.body;

    if (obs.done) break;

    for (const p of obs.pending) {
      const key = keyOf(p);
      if (started.has(key) || inFlight.size >= CONCURRENCY) continue;

      started.add(key);
      const task = (async () => {
        try {
          let act = fallbackFor(p);
          try {
            act = await decide(p, rng);
          } catch {}
          await envPost('/act', act);
        } catch {}
      })().finally(() => inFlight.delete(key));

      inFlight.set(key, task);
    }

    if (inFlight.size > 0) {
      const waiting = obs.pending.some((p) => !started.has(keyOf(p)));
      if (inFlight.size >= CONCURRENCY || !waiting) {
        await Promise.race(inFlight.values());
      }
    } else if (obs.pending.length > 0) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  await Promise.all(inFlight.values());
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await run();
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`${(err).stack ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
