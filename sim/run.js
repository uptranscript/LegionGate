"use strict";
// run.js — CLI batch runner for the headless gate-shooter sim.
//
// Usage:
//   node sim/run.js --seeds 50 --seedBase 1000 --skills weak,average,good \
//     --cap 600 --scoreCap 2000000 --dt 0.05 --out sim/results/x.json \
//     [--indexPath path] [--bot smart|random] [--workers N] [--quiet]
//
// For every (skill, seedBase+i) it: createSim -> __sim.start() -> loop
// { bot.decide -> tick(dt, targetX) } until one of:
//   - !running           (squad died)
//   - time >= cap        (time budget exhausted; counts as survived-to-cap)
//   - score >= scoreCap  (score ceiling; survival-style early stop)
// The dual time+score ceiling is the mandatory safety net against runs that
// never end because a build became trivially survivable.
//
// Parallelism: seeds are split across child_process.fork workers. The same
// file is the worker entry (detected via process.env.SIM_WORKER); each worker
// runs an assigned slice of jobs and streams per-run records back over IPC.
//
// Output: --out gets the full per-run detail; stdout's LAST line is the
// one-line "AGGREGATE: {...}" summary that downstream tooling parses.

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const { createSim } = require("./harness.js");
const { makeBot } = require("./bot.js");

// ---------------------------------------------------------------- arg parse
function parseArgs(argv) {
  const a = {
    seeds: 50,
    seedBase: 1000,
    skills: ["weak", "average", "good"],
    cap: 600,
    scoreCap: 2000000,
    dt: 0.05,
    out: null,
    indexPath: path.join(__dirname, "..", "index.html"),
    bot: "smart",
    workers: null,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--seeds": a.seeds = parseInt(v, 10); i++; break;
      case "--seedBase": a.seedBase = parseInt(v, 10); i++; break;
      case "--skills": a.skills = String(v).split(",").map(s => s.trim()).filter(Boolean); i++; break;
      case "--cap": a.cap = parseFloat(v); i++; break;
      case "--scoreCap": a.scoreCap = parseFloat(v); i++; break;
      case "--dt": a.dt = parseFloat(v); i++; break;
      case "--out": a.out = v; i++; break;
      case "--indexPath": a.indexPath = v; i++; break;
      case "--bot": a.bot = v; i++; break;
      case "--workers": a.workers = parseInt(v, 10); i++; break;
      case "--quiet": a.quiet = true; break;
      default:
        if (k && k.startsWith("--")) {
          // tolerate unknown flags with a value, ignore lone flags
          if (v && !v.startsWith("--")) i++;
        }
    }
  }
  if (!a.indexPath) a.indexPath = path.join(__dirname, "index.html");
  // Resolve indexPath relative to CWD if not absolute.
  a.indexPath = path.resolve(a.indexPath);
  return a;
}

function defaultWorkers() {
  const c = (os.cpus() || []).length;
  return Math.min(6, Math.max(2, c - 2));
}

// ---------------------------------------------------------------- one run
// Plays a single (skill, seed) to completion and returns a per-run record.
function runOne(skill, seed, cfg) {
  const botKind = cfg.bot === "random" ? "random" : skill;
  let sim, events;
  try {
    const built = createSim({ seed, indexPath: cfg.indexPath });
    sim = built.sim;
    events = built.events;
  } catch (e) {
    return {
      skill, seed, error: String(e && e.stack || e),
      survivalSec: 0, reachedHard: false, afterHardSec: 0,
      maxSoldiers: 0, score: 0, rank: 0, kills: 0,
      aliveAtCap: false, scoreCapped: false, nan: false,
      deathPhase: "error", lastEvents: [],
      allTrapPairs: 0, decontamEvents: 0, evolveEvents: 0, specialEvents: 0, medianLifespan: 0, maxOnScreen: 0, pctPressure: 0, soldierLossTotal: 0,
    };
  }

  const HARD = sim.getHard();
  const hardStartSec = HARD ? (HARD.startWave - 1) * 18 : Infinity;

  const bot = makeBot(botKind, seed);
  sim.start();
  let state = sim.getState();

  const dt = cfg.dt;
  const cap = cfg.cap;
  const scoreCap = cfg.scoreCap;

  let maxSoldiers = Number.isFinite(state.soldiers) ? state.soldiers : 0;
  let nan = false;
  let aliveAtCap = false;
  let scoreCapped = false;
  let reachedHard = false;

  // sanity + threat-feel trackers (per-run; aggregated by master)
  const SQUAD_Y = sim.consts.SQUAD_Y;
  let allTrapPairs = 0;   // gate pairs where EVERY cell is a trap (spec: must never happen)
  let decontamEvents = 0;
  let maxOnScreen = 0;
  let pressureTicks = 0;  // ticks with >=1 live enemy near the squad line
  let tickCount = 0;
  let soldierLossTotal = 0;
  const seenPairs = new WeakSet();      // gate pairs already inspected
  const negDecontam = new WeakSet();    // gate cells already counted as decontaminated
  // enemy lifespan ("felt strength": one-shot enemies die at ~dt; tanky ones live longer)
  const enemyFirst = new Map();         // enemy obj -> first time seen
  const lifespans = [];
  let prevSoldiers = state.soldiers;

  const maxTicks = Math.ceil(cap / dt) + 4;
  let running = true;

  for (let t = 0; t < maxTicks; t++) {
    tickCount++;
    // --- gate sanity scan ---
    for (const gp of state.gates) {
      const cells = gp.cells || [];
      if (!seenPairs.has(gp)) {
        seenPairs.add(gp);
        if (cells.length && cells.every(c => !((c.kind === "add" && c.val >= 0) || c.kind === "mul" ||
            ["rapid", "spread", "shield", "bomb", "elite"].includes(c.kind)))) allTrapPairs++;
      }
      for (const c of cells) {
        if (c.kind === "add" && c.val < 0) c.__wasNeg = true;
        else if (c.kind === "add" && c.val >= 0 && c.__wasNeg && !negDecontam.has(c)) {
          negDecontam.add(c); decontamEvents++;
        }
      }
    }

    // --- threat-feel telemetry on the live enemy set ---
    const now = state.time;
    let live = 0, pressure = false;
    const present = new Set();
    for (const e of state.enemies) {
      if (e.hp <= 0) continue;
      live++; present.add(e);
      if (!enemyFirst.has(e)) enemyFirst.set(e, now);
      if (!e.boss && e.y > SQUAD_Y - 130 && e.y < SQUAD_Y + 40) pressure = true;
    }
    for (const [e, t0] of enemyFirst) {
      if (!present.has(e)) { lifespans.push(now - t0); enemyFirst.delete(e); }
    }
    if (live > maxOnScreen) maxOnScreen = live;
    if (pressure) pressureTicks++;

    if (reachedHard === false && state.time >= hardStartSec) reachedHard = true;

    // score ceiling stop (survival-style)
    if (state.score >= scoreCap) { scoreCapped = true; break; }
    // time ceiling stop
    if (state.time >= cap) { aliveAtCap = true; break; }

    const targetX = bot.decide(state, sim);
    running = sim.tick(dt, targetX);
    state = sim.getState();

    if (!Number.isFinite(state.soldiers)) { nan = true; break; }
    if (state.soldiers > maxSoldiers) maxSoldiers = state.soldiers;
    if (state.soldiers < prevSoldiers) soldierLossTotal += prevSoldiers - state.soldiers;
    prevSoldiers = state.soldiers;

    if (!running) break; // death
  }

  // After-loop: catch a final decontam transition and reachedHard.
  if (reachedHard === false && state.time >= hardStartSec) reachedHard = true;

  const survivalSec = Math.min(state.time, cap);
  const afterHardSec = reachedHard ? Math.max(0, survivalSec - hardStartSec) : 0;
  const lastEvents = events.slice(-5).map(e => ({ time: Math.round(e.time * 10) / 10, text: e.text }));

  // event-derived counters (verify evolution is reachable + specials fire)
  let evolveEvents = 0, specialEvents = 0;
  const SPECIAL_RE = /連射強化|拡散弾|シールド|精鋭化|殲滅/;
  for (const e of events) {
    if (e.text.indexOf("進化") >= 0) evolveEvents++;
    else if (SPECIAL_RE.test(e.text)) specialEvents++;
  }

  let deathPhase;
  if (nan) deathPhase = "nan";
  else if (scoreCapped) deathPhase = "scoreCapped";
  else if (aliveAtCap) deathPhase = "aliveAtCap";
  else deathPhase = reachedHard ? "inHard" : "preHard";

  return {
    skill, seed,
    survivalSec: Math.round(survivalSec * 100) / 100,
    reachedHard,
    afterHardSec: Math.round(afterHardSec * 100) / 100,
    maxSoldiers,
    score: Math.floor(state.score),
    rank: state.rank,
    kills: state.kills,
    aliveAtCap,
    scoreCapped,
    nan,
    deathPhase,
    lastEvents,
    allTrapPairs,
    decontamEvents,
    evolveEvents,
    specialEvents,
    medianLifespan: Math.round(median(lifespans) * 1000) / 1000,
    maxOnScreen,
    pctPressure: tickCount ? Math.round(pressureTicks / tickCount * 1000) / 1000 : 0,
    soldierLossTotal,
  };
}

// ---------------------------------------------------------------- job list
function buildJobs(cfg) {
  const jobs = [];
  for (const skill of cfg.skills) {
    for (let i = 0; i < cfg.seeds; i++) {
      jobs.push({ skill, seed: cfg.seedBase + i });
    }
  }
  return jobs;
}

// ---------------------------------------------------------------- stats
function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function aggregate(records, cfg, HARD, hardStartSec) {
  const bySkill = {};
  for (const skill of cfg.skills) {
    const rs = records.filter(r => r.skill === skill);
    const n = rs.length;
    const reached = rs.filter(r => r.reachedHard);
    const afterHardVals = reached.map(r => r.afterHardSec);
    const longSurvive = reached.filter(r => r.afterHardSec >= 240).length;
    bySkill[skill] = {
      n,
      pctReachedHard: n ? reached.length / n : 0,
      medianTotal: median(rs.map(r => r.survivalSec)),
      medianAfterHard: median(afterHardVals),
      pctLongSurvive: reached.length ? longSurvive / reached.length : 0,
      aliveAtCap: rs.filter(r => r.aliveAtCap).length,
      scoreCapped: rs.filter(r => r.scoreCapped).length,
      medianMaxSoldiers: median(rs.map(r => r.maxSoldiers)),
      medianScore: median(rs.map(r => r.score)),
      deathsPreHard: rs.filter(r => !r.reachedHard && !r.nan && !r.error && !r.aliveAtCap && !r.scoreCapped).length,
      deathsInHard: rs.filter(r => r.reachedHard && !r.aliveAtCap && !r.scoreCapped && !r.nan && !r.error).length,
      // threat-feel: are enemies actually surviving bullets, and is the field pressured?
      medianEnemyLifespan: Math.round(median(rs.map(r => r.medianLifespan || 0)) * 1000) / 1000,
      medianMaxOnScreen: median(rs.map(r => r.maxOnScreen || 0)),
      medianPctPressure: Math.round(median(rs.map(r => r.pctPressure || 0)) * 1000) / 1000,
      medianEvolveEvents: median(rs.map(r => r.evolveEvents || 0)),
      medianSpecialEvents: median(rs.map(r => r.specialEvents || 0)),
    };
  }

  const sanity = {
    allTrapPairs: records.reduce((a, r) => a + (r.allTrapPairs || 0), 0), // 全cell罠 (0であるべき)
    nanRuns: records.filter(r => r.nan).length,
    errorRuns: records.filter(r => r.error).length,
    decontamEvents: records.reduce((a, r) => a + (r.decontamEvents || 0), 0),
    evolveEvents: records.reduce((a, r) => a + (r.evolveEvents || 0), 0),    // x2進化総数 (>0であるべき)
    specialEvents: records.reduce((a, r) => a + (r.specialEvents || 0), 0),  // 特殊ゲート発動総数
  };

  return {
    config: {
      seeds: cfg.seeds,
      cap: cfg.cap,
      scoreCap: cfg.scoreCap,
      dt: cfg.dt,
      seedBase: cfg.seedBase,
      hardStartSec,
      HARD: HARD || null,
    },
    bySkill,
    sanity,
  };
}

// ---------------------------------------------------------------- worker
// A forked worker: receives { jobs, cfg }, runs them, streams results, exits.
function runAsWorker() {
  process.on("message", (msg) => {
    if (!msg || msg.type !== "jobs") return;
    const { jobs, cfg } = msg;
    for (const job of jobs) {
      let rec;
      try {
        rec = runOne(job.skill, job.seed, cfg);
      } catch (e) {
        rec = {
          skill: job.skill, seed: job.seed, error: String(e && e.stack || e),
          survivalSec: 0, reachedHard: false, afterHardSec: 0, maxSoldiers: 0,
          score: 0, rank: 0, kills: 0, aliveAtCap: false, scoreCapped: false,
          nan: false, deathPhase: "error", lastEvents: [], allTrapPairs: 0, decontamEvents: 0, evolveEvents: 0, specialEvents: 0, medianLifespan: 0, maxOnScreen: 0, pctPressure: 0, soldierLossTotal: 0,
        };
      }
      process.send({ type: "result", rec });
    }
    process.send({ type: "done" });
  });
}

// ---------------------------------------------------------------- master
function runMaster(cfg) {
  const jobs = buildJobs(cfg);
  const total = jobs.length;
  if (total === 0) {
    process.stderr.write("run.js: no jobs (empty --skills or --seeds 0)\n");
    process.stdout.write("AGGREGATE: " + JSON.stringify(aggregate([], cfg, null, 0)) + "\n");
    return Promise.resolve();
  }

  // Read HARD once up front (deterministic across runs) for the config block.
  let HARD = null, hardStartSec = 0;
  try {
    const probe = createSim({ seed: cfg.seedBase, indexPath: cfg.indexPath });
    HARD = probe.sim.getHard();
    hardStartSec = HARD ? (HARD.startWave - 1) * 18 : 0;
  } catch (e) {
    process.stderr.write("run.js: WARN could not probe HARD: " + (e && e.message) + "\n");
  }

  const workerCount = Math.max(1, Math.min(cfg.workers || defaultWorkers(), total));
  const useWorkers = workerCount > 1 && total > 1;

  const records = [];
  let doneCount = 0;
  const t0 = Date.now();

  function progress() {
    if (cfg.quiet) return;
    if (doneCount % 10 === 0 || doneCount === total) {
      const el = ((Date.now() - t0) / 1000).toFixed(1);
      process.stderr.write(`[sim] ${doneCount}/${total} runs (${el}s)\n`);
    }
  }

  // --- single-process fallback (no fork) ---
  if (!useWorkers) {
    for (const job of jobs) {
      const rec = runOne(job.skill, job.seed, cfg);
      records.push(rec);
      doneCount++;
      progress();
    }
    return finish(records, cfg, HARD, hardStartSec);
  }

  // --- parallel: round-robin jobs into worker chunks ---
  const chunks = Array.from({ length: workerCount }, () => []);
  jobs.forEach((job, i) => chunks[i % workerCount].push(job));

  return new Promise((resolve) => {
    let liveWorkers = 0;
    for (let w = 0; w < workerCount; w++) {
      const chunk = chunks[w];
      if (!chunk.length) continue;
      liveWorkers++;
      const child = cp.fork(__filename, [], {
        env: Object.assign({}, process.env, { SIM_WORKER: "1" }),
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });
      child.on("message", (msg) => {
        if (!msg) return;
        if (msg.type === "result") {
          records.push(msg.rec);
          doneCount++;
          progress();
        } else if (msg.type === "done") {
          child.disconnect();
        }
      });
      child.on("exit", () => {
        liveWorkers--;
        if (liveWorkers === 0) resolve(finish(records, cfg, HARD, hardStartSec));
      });
      child.on("error", (err) => {
        process.stderr.write("run.js: worker error: " + err.message + "\n");
      });
      child.send({ type: "jobs", jobs: chunk, cfg });
    }
    if (liveWorkers === 0) resolve(finish(records, cfg, HARD, hardStartSec));
  });
}

function finish(records, cfg, HARD, hardStartSec) {
  // Stable ordering: by skill (as given), then seed.
  const skillOrder = new Map(cfg.skills.map((s, i) => [s, i]));
  records.sort((a, b) => {
    const sa = skillOrder.has(a.skill) ? skillOrder.get(a.skill) : 99;
    const sb = skillOrder.has(b.skill) ? skillOrder.get(b.skill) : 99;
    return sa - sb || a.seed - b.seed;
  });

  const agg = aggregate(records, cfg, HARD, hardStartSec);

  if (cfg.out) {
    const outPath = path.resolve(cfg.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const payload = {
      generatedAt: new Date().toISOString(),
      config: agg.config,
      aggregate: { bySkill: agg.bySkill, sanity: agg.sanity },
      runs: records,
    };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    if (!cfg.quiet) process.stderr.write(`[sim] wrote ${records.length} runs -> ${outPath}\n`);
  }

  // The contract: stdout's final line is the one-line AGGREGATE.
  process.stdout.write("AGGREGATE: " + JSON.stringify(agg) + "\n");
  return Promise.resolve(agg);
}

// ---------------------------------------------------------------- entry
if (process.env.SIM_WORKER === "1") {
  runAsWorker();
} else {
  const cfg = parseArgs(process.argv.slice(2));
  runMaster(cfg).then(() => {
    // Allow any lingering child IPC to flush, then exit cleanly.
    process.exitCode = 0;
  }).catch((e) => {
    process.stderr.write("run.js: fatal: " + (e && e.stack || e) + "\n");
    process.exitCode = 1;
  });
}

module.exports = { runOne, aggregate, parseArgs, buildJobs };
