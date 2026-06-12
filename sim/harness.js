"use strict";
// harness.js — vm-based headless loader for the gate-shooter game.
// Extracts the <script> body from index.html, runs it inside a vm context
// with a DOM stub, then injects a seeded RNG and driving hooks so the game
// can be ticked deterministically with no rendering.
//
// Exports: createSim({ seed, indexPath }) ->
//   { sim, events, ctx }
//   sim   : the in-context __sim driver { start, tick, getState, getHard, consts }
//   events: array (shared by reference) of { time, text } float-text events
//   ctx   : the vm context (for advanced inspection)

const fs = require("fs");
const vm = require("vm");

// Deterministic PRNG. Returns a function producing floats in [0,1).
function mulberry32Source() {
  // Returned as source so it is defined *inside* the vm context and replaces
  // that context's Math.random (the game closes over the global Math).
  return `
  (function(){
    function mulberry32(a){
      return function(){
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    return mulberry32;
  })()`;
}

function extractScript(html) {
  // Grab the first non-trivial <script>...</script> block. The game uses a
  // single inline script; pick the largest match to be safe.
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m, best = "";
  while ((m = re.exec(html)) !== null) {
    if (m[1] && m[1].length > best.length) best = m[1];
  }
  if (!best) throw new Error("harness: no <script> block found in HTML");
  return best;
}

// Build a ctx2d stub via Proxy: every property access returns a no-op
// function, except createLinearGradient/createRadialGradient which return a
// gradient stub. The game never calls draw() under the sim, but we keep this
// safe in case any draw path is reached.
function makeCtx2d() {
  const gradientStub = { addColorStop() {} };
  const handler = {
    get(_t, prop) {
      if (prop === "createLinearGradient" || prop === "createRadialGradient") {
        return () => gradientStub;
      }
      if (prop === "canvas") return undefined;
      // numeric-ish state props the game might read back
      if (prop === "globalAlpha" || prop === "lineWidth") return 1;
      if (prop === "fillStyle" || prop === "strokeStyle" || prop === "font" ||
          prop === "textAlign") return "";
      return () => {};
    },
    set() { return true; },
  };
  return new Proxy({}, handler);
}

function makeElementStub() {
  return {
    addEventListener() {},
    removeEventListener() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {},
    dataset: {},
    textContent: "",
    value: "",
    width: 0,
    height: 0,
    get innerHTML() { return ""; },
    set innerHTML(_v) { /* no-op */ },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    appendChild(c) { return c; },
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
    click() {},
    getContext() { return makeCtx2d(); },
    getBoundingClientRect() { return { left: 0, top: 0, right: 480, bottom: 720, width: 480, height: 720 }; },
    requestPointerLock() {},
    toBlob(cb) { cb(null); },
  };
}

function createSim({ seed = 0, indexPath } = {}) {
  if (!indexPath) throw new Error("createSim: indexPath is required");
  const html = fs.readFileSync(indexPath, "utf8");
  const code = extractScript(html);

  const ctx2d = makeCtx2d();

  // canvas: the element with id "game". width/height back the W/H consts.
  const canvasStub = makeElementStub();
  canvasStub.width = 480;
  canvasStub.height = 720;
  canvasStub.getContext = () => ctx2d;
  canvasStub.getBoundingClientRect = () => ({ left: 0, top: 0, right: 480, bottom: 720, width: 480, height: 720 });
  canvasStub.requestPointerLock = () => {};
  canvasStub.toBlob = (cb) => cb(null);

  const elementCache = { game: canvasStub };
  function getEl(id) {
    if (!elementCache[id]) elementCache[id] = makeElementStub();
    return elementCache[id];
  }

  const documentStub = {
    getElementById: getEl,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tag) {
      if (tag === "canvas") {
        const c = makeElementStub();
        c.width = 480; c.height = 720;
        c.getContext = () => makeCtx2d();
        c.toBlob = (cb) => cb(null);
        return c;
      }
      return makeElementStub();
    },
    addEventListener() {},
    removeEventListener() {},
    exitPointerLock() {},
    pointerLockElement: null,
    body: makeElementStub(),
  };

  // Host-side event sink. The injected hook pushes float-text events here.
  const events = [];

  const sandbox = {
    document: documentStub,
    canvas: canvasStub,
    console,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    performance: { now: () => 0 },
    requestAnimationFrame: function (_f) { /* never invoked: sim drives manually */ return 0; },
    cancelAnimationFrame: function () {},
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    addEventListener: function () {},
    removeEventListener: function () {},
    navigator: {},
    URL: { createObjectURL: () => "", revokeObjectURL() {} },
    Math: Math,
    Date: Date,
    JSON: JSON,
    // AudioContext intentionally left undefined -> game try/catch -> audioCtx=null.
    __simEvents: events,
  };
  // window === the global object of the context.
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);

  // 1) Install the seeded RNG BEFORE the game runs, so any module-load-time
  //    Math.random calls are already deterministic. The game body closes over
  //    the global Math object, so replacing Math.random here affects it.
  vm.runInContext(
    `Math.random = (${mulberry32Source()})(${seed | 0});`,
    context,
    { filename: "sim-rng.js" }
  );

  // 2) Run the extracted game script in the SAME context. Its top-level
  //    let/const (state, update, level, W, H, SQUAD_Y, gateResult, ...) live in
  //    the context's global lexical environment and are reachable by subsequent
  //    runInContext calls.
  vm.runInContext(code, context, { filename: "game.js" });

  // 3) Inject driving hooks + event recording in the same lexical scope so the
  //    top-level bindings are visible.
  const driver = `
  (function () {
    // Wrap addFloatText to record death-cause / event timeline.
    if (typeof addFloatText === "function") {
      var __origAddFloat = addFloatText;
      addFloatText = function (x, y, text, color, size) {
        try {
          __simEvents.push({ time: (typeof state !== "undefined" && state) ? state.time : 0, text: String(text) });
        } catch (e) {}
        return __origAddFloat(x, y, text, color, size);
      };
    }

    globalThis.__sim = {
      start: function () {
        state = newState();
        state.running = true;
        return state;
      },
      tick: function (dt, targetX) {
        if (typeof targetX === "number") state.targetX = targetX;
        update(dt);
        return state.running;
      },
      getState: function () { return state; },
      getHard: function () { return typeof HARD !== "undefined" ? HARD : null; },
      consts: { W: W, H: H, SQUAD_Y: SQUAD_Y }
    };
  })();
  `;
  vm.runInContext(driver, context, { filename: "sim-driver.js" });

  if (!context.__sim) throw new Error("harness: __sim was not installed (driver injection failed)");

  return { sim: context.__sim, events, ctx: context };
}

module.exports = { createSim, extractScript };
