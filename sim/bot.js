"use strict";
// bot.js — user AI for the headless gate-shooter sim.
//
// makeBot(skillName, seed) -> { decide(state, sim) -> targetX }
//
// The bot reasons purely off the live `state` object handed back by the sim
// (gates, enemies, eBullets, soldiers, squadX). It is intentionally a *local*
// re-implementation of the game's gate math so it never reaches into game
// internals beyond reading public state fields.
//
// Decision cadence: a fresh target is computed every `reactTicks` ticks; in
// between it holds the previous value (models human reaction latency). Layered:
//   1) pick the cheaper-to-reach beneficial gate side (with a mistake chance),
//   2) lock the horizontal band as the pair nears the squad line,
//   3) dodge live enemies + predicted enemy-bullet impact points.

// ---- per-skill profiles -------------------------------------------------
const SKILLS = {
  good:    { mistake: 0.03, reactTicks: 5, dodgeRadius: 65, afkProb: 0, aimW: 0.50 },
  average: { mistake: 0.14, reactTicks: 6, dodgeRadius: 60, afkProb: 0.004, aimW: 0.35 },
  weak:    { mistake: 0.18, reactTicks: 9, dodgeRadius: 35, afkProb: 0.01, aimW: 0.18 }, // afkProb is per-second
  // "random" handled specially below
};
// Experimental profiles via env: SIM_SKILLS='{"goodA":{"mistake":0.03,...}}'
// merged over the defaults so A/B parameter probes need no code edits.
if (process.env.SIM_SKILLS) {
  try {
    const patch = JSON.parse(process.env.SIM_SKILLS);
    for (const k of Object.keys(patch)) {
      SKILLS[k] = Object.assign({}, SKILLS[k.replace(/[A-Z0-9]+$/, "")] || SKILLS.average, patch[k]);
    }
  } catch (e) { /* ignore malformed overrides */ }
}

// ---- local mirror of the game's gate semantics --------------------------
// gateResult: add -> n+val, mul -> n*val, div -> floor(n/val)
function gateResult(side, n) {
  if (side.kind === "add") return n + side.val;
  if (side.kind === "mul") return n * side.val;
  return Math.floor(n / side.val); // div
}
// gateIsGood: (add && val>=0) || mul
function gateIsGood(side) {
  return (side.kind === "add" && side.val >= 0) || side.kind === "mul";
}

// Deterministic PRNG so each (skill, seed) plays identically across runs.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBot(skillName, seed) {
  const isRandom = skillName === "random";
  const cfg = SKILLS[skillName] || SKILLS.average;
  const rng = mulberry32((seed | 0) ^ 0x9e3779b9);

  // --- persistent bot memory across ticks ---
  let tickCount = 0;
  let lastTarget = 240;          // center of the field by default
  // per-gate-pair mistake decision cache, keyed by pair identity
  const pairMistake = new Map(); // pairId -> bool (commit to worse side)
  let pairSeq = 0;               // identity counter for pairs we have seen
  const pairIds = new WeakMap(); // gate object -> stable id

  // AFK (weak skill): when triggered, freeze input (hold lastTarget) for 0.5s.
  let afkUntil = -1;             // state.time until which we are AFK
  // random skill: re-roll a fresh uniform x every 0.5s.
  let randomNextAt = 0;
  let randomTarget = 240;

  const W = 480, HW = 240, SQUAD_Y = 640;
  const LEFT_MIN = 30, LEFT_MAX = HW - 30;   // band for the left side: 30..210
  const RIGHT_MIN = HW + 30, RIGHT_MAX = W - 30; // band for the right side: 270..450

  function pairIdOf(gp) {
    let id = pairIds.get(gp);
    if (id === undefined) { id = pairSeq++; pairIds.set(gp, id); }
    return id;
  }

  // Utility for a side, used both to pick AND to score "regret" of discarding.
  // Returns -Infinity-ish for instant-death sides so they are avoided when the
  // other side survives.
  function sideValue(side, n) {
    return gateResult(side, n);
  }

  // Cost of discarding `side`: the enemy pickup it triggers (skipped mul ->
  // next wave count x2..3, skipped positive add -> wave HP+). That pain scales
  // with how big our army (and thus the matched enemy wave) currently is, NOT
  // with the gate's face value — a flat constant makes tiny armies wrongly
  // prefer x2 over a far larger +N.
  function discardLoss(side, n) {
    if (side.kind === "mul") return 5 + 0.15 * n;
    if (side.kind === "add" && side.val > 0) return 0.3 * side.val;
    return 0; // trap side: no penalty (matches game design)
  }

  // Choose the best gate pair to commit to: nearest un-done pair above the
  // squad line. Returns { gp, side } or null.
  function chooseGate(state) {
    let best = null, bestDy = Infinity;
    for (const gp of state.gates) {
      if (gp.done) continue;
      if (gp.y >= SQUAD_Y) continue; // already at/past the squad
      const dy = SQUAD_Y - gp.y;
      if (dy < bestDy) { bestDy = dy; best = gp; }
    }
    if (!best) return null;

    const n = state.soldiers;
    const L = best.left, R = best.right;
    const lv = sideValue(L, n), rv = sideValue(R, n);

    // Death avoidance: if one side wipes us (<=0) and the other survives,
    // forcibly exclude the lethal side.
    const lDead = lv <= 0, rDead = rv <= 0;
    let preferLeft;
    if (lDead && !rDead) preferLeft = false;       // left wipes us -> pick right
    else if (rDead && !lDead) preferLeft = true;   // right wipes us -> pick left
    else {
      // Net merit = resulting soldiers minus the regret of discarding the other.
      const leftMerit = lv - discardLoss(R, n);
      const rightMerit = rv - discardLoss(L, n);
      preferLeft = leftMerit >= rightMerit;
    }

    // Mistake: per pair, at most once, flip to the strictly worse side.
    const pid = pairIdOf(best);
    if (!pairMistake.has(pid)) {
      pairMistake.set(pid, rng() < cfg.mistake);
    }
    if (pairMistake.get(pid) && !(lDead && !rDead) && !(rDead && !lDead)) {
      // Only flip when there is a genuinely worse-but-survivable side, and the
      // call is actually close (>=40% of the better side). Weak humans misjudge
      // near-ties; they do not walk into obvious x2-vs-÷2 catastrophes.
      const worseIsLeft = lv < rv;
      const worseVal = Math.min(lv, rv), betterVal = Math.max(lv, rv);
      if (worseVal > 0 && lv !== rv && worseVal >= betterVal * 0.4) preferLeft = worseIsLeft;
    }

    return { gp: best, side: preferLeft ? L : R, preferLeft };
  }

  // Build the list of threats (x position, weight) that can hit the squad line.
  // Enemies are projected forward to their predicted x at the squad's y (so fast
  // descenders/divers are caught early), plus predicted enemy-bullet impacts.
  function collectThreats(state) {
    const threats = [];
    for (const e of state.enemies) {
      if (e.hp <= 0) continue;
      if (e.y > SQUAD_Y + 40) continue;        // already past the squad line
      const vy = e.vy || 0;
      // Time for this enemy to reach the contact line (SQUAD_Y - 24).
      let tHit = vy > 0 ? (SQUAD_Y - 24 - e.y) / vy : (e.y > SQUAD_Y - 150 ? 0 : Infinity);
      if (tHit < 0) tHit = 0;
      if (tHit > 2.6) continue;                // too far up to matter yet
      // Predicted impact x (enemies mostly fall straight; vx is small wobble).
      const px = e.x + (e.vx || 0) * Math.min(tHit, 1.2);
      // Sooner + bigger => more urgent.
      const urgency = (1 - tHit / 2.6) + (e.boss ? 1 : 0);
      threats.push({ x: px, w: 0.6 + urgency });
      // Also treat its CURRENT x as a (lighter) threat if it is already low,
      // so lateral wobble near the line is respected.
      if (e.y > SQUAD_Y - 150) threats.push({ x: e.x, w: 0.5 });
    }
    for (const b of state.eBullets) {
      if (b.dead || b.vy <= 0) continue;
      const t = (SQUAD_Y - b.y) / b.vy;        // time to reach the squad line
      if (t < 0 || t > 2.6) continue;
      const px = b.x + b.vx * t;
      threats.push({ x: px, w: 2.0 });
    }
    return threats;
  }

  // Aim targets: enemies far enough upstream to shoot safely. Standing under
  // them is how the squad's narrow bullet column actually lands hits — without
  // this the bot positions for gates/dodging only and most bullets miss.
  function collectAimTargets(state) {
    const aims = [];
    for (const e of state.enemies) {
      if (e.hp <= 0) continue;
      if (e.y < 40 || e.y > SQUAD_Y - 140) continue;
      aims.push({ x: e.x, w: e.boss ? 2.5 : 1 });
    }
    return aims;
  }

  // Reward for standing at x: enemies inside the bullet column (~±50px).
  function aimValueAt(x, aims) {
    let v = 0;
    for (const a of aims) {
      const dx = Math.abs(a.x - x);
      if (dx >= 50) continue;
      v += a.w * (1 - dx / 50);
    }
    return v;
  }

  // Danger score for standing at x: high when threats are within dodgeRadius.
  function dangerAt(x, threats, R) {
    let d = 0;
    for (const th of threats) {
      const dx = Math.abs(th.x - x);
      if (dx >= R) continue;
      // Soft kernel: contact band (<70px, the game's hit width) dominates.
      const prox = 1 - dx / R;
      const contact = dx < 72 ? (1 - dx / 72) * 3 : 0;
      d += th.w * (prox + contact);
    }
    return d;
  }

  // Threat-aware positioning inside an allowed band. Scans the band for the
  // safest spot (lowest threat density) while keeping `target` as a soft
  // attractor (strength = pull), so the squad drifts toward its chosen gate
  // side only when doing so is safe. Lower pull => survival dominates.
  function dodge(state, target, band, pull) {
    const R = cfg.dodgeRadius;
    const threats = collectThreats(state);
    const aims = collectAimTargets(state);
    if (threats.length === 0 && aims.length === 0) return target;

    // Local search only: humans sidestep, they do not teleport across the
    // field. Scanning the whole band makes the squad sweep laterally through
    // the bottom row and take contact hits, so restrict candidates to a
    // window around where the squad actually is.
    const sx = state.squadX;
    const lo = Math.max(band[0], sx - 140), hi = Math.min(band[1], sx + 140);
    const targetClamped = Math.max(lo, Math.min(hi, target));

    // Cost = danger - aim payoff + leash to the attractor. The aim term makes
    // the squad drift under upstream enemies so its bullet column lands.
    // A small army farms cautiously: survival outweighs chasing kills until
    // the squad has a cushion (humans play scared when one hit hurts).
    const aimScale = Math.min(1, state.soldiers / 25 + 0.4);
    const costAt = (x) =>
      dangerAt(x, threats, R) - aimValueAt(x, aims) * cfg.aimW * aimScale +
      Math.abs(x - targetClamped) * pull;

    let bestX = targetClamped, bestCost = costAt(targetClamped);
    const STEP = 10;
    for (let x = lo; x <= hi + 0.5; x += STEP) {
      const cost = costAt(x);
      // Require a real improvement before abandoning the attractor (stability).
      if (cost < bestCost - 0.25) { bestCost = cost; bestX = x; }
    }
    return Math.max(lo, Math.min(hi, bestX));
  }

  function decideSmart(state) {
    const sel = chooseGate(state);

    let target;                          // soft attractor x (gate side / center)
    let band = [LEFT_MIN, RIGHT_MAX];    // full field until a pair is committed
    let hardLock = false;
    let pull = 0.012;                    // attractor strength for the dodge scan

    // Boss priority: a parked boss streams percentage-damage volleys — leaving
    // it alive bleeds any army to death. Unless a gate crossing is imminent,
    // park under the boss so the bullet column melts it (what humans do first).
    const boss = state.enemies.find(e => e.boss && e.hp > 0);
    const gateImminent = sel && sel.gp.y > SQUAD_Y - 160;
    if (boss && boss.y < SQUAD_Y - 100 && !gateImminent) {
      const t = dodge(state, Math.max(LEFT_MIN, Math.min(RIGHT_MAX, boss.x)), [LEFT_MIN, RIGHT_MAX], 0.02);
      return Math.max(LEFT_MIN, Math.min(RIGHT_MAX, t));
    }

    if (sel) {
      const side = sel.side;
      const center = side.x + side.w / 2; // left -> 125, right -> 355
      target = center;

      if (sel.gp.y > SQUAD_Y - 260) {
        // Committed window: constrain to the chosen side's half and pull hard so
        // we actually arrive on the right half before the gate resolves.
        band = sel.preferLeft ? [LEFT_MIN, LEFT_MAX] : [RIGHT_MIN, RIGHT_MAX];
        pull = 0.05;
      } else {
        // Gate still far: farm enemies (aim layer dominates) — camping under a
        // distant gate both wastes the bullet column and halves bullet damage
        // through the gate band. The commit window handles arrival later.
        pull = 0.005;
      }

      // Final approach: hard lock to the side (cross no matter what).
      if (sel.gp.y > SQUAD_Y - 80) {
        hardLock = true;
        target = sel.preferLeft
          ? Math.min(center, LEFT_MAX)
          : Math.max(center, RIGHT_MIN);
      }

      // Decontam: a negative-add chosen side wants our bullets under it.
      if (side.kind === "add" && side.val < 0) {
        target = Math.max(band[0], Math.min(band[1], center));
      }
    } else {
      target = 240; // no live pair: idle near center, survival-first
      pull = 0.006;
    }

    // Dodge layer (skipped during the final hard lock to guarantee the pass).
    if (!hardLock) {
      target = dodge(state, target, band, pull);
    }

    return Math.max(LEFT_MIN, Math.min(RIGHT_MAX, target));
  }

  function decide(state /*, sim */) {
    tickCount++;
    const dt = 0.05; // sim default; only used for per-second probability scaling

    // ---- random baseline bot ----
    if (isRandom) {
      if (state.time >= randomNextAt) {
        randomNextAt = state.time + 0.5;
        randomTarget = LEFT_MIN + rng() * (RIGHT_MAX - LEFT_MIN);
      }
      lastTarget = randomTarget;
      return lastTarget;
    }

    // ---- AFK handling (weak) ----
    if (cfg.afkProb > 0) {
      if (state.time < afkUntil) {
        return lastTarget; // frozen input
      }
      // Per-tick AFK roll derived from per-second probability.
      if (rng() < cfg.afkProb * dt) {
        afkUntil = state.time + 0.5;
        return lastTarget;
      }
    }

    // ---- reaction cadence: only recompute every reactTicks ----
    if (tickCount % cfg.reactTicks !== 0) {
      return lastTarget;
    }

    lastTarget = decideSmart(state);
    return lastTarget;
  }

  return { decide };
}

module.exports = { makeBot };
