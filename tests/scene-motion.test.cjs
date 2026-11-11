const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, file);
const { motionBlend, frameBlend, nearestAngle, SceneGesture, zoomRadius } = require("../src/lib/scene-motion.ts");

test("camera settles equally after one second at 10, 30, 60, and 120 fps", () => {
  for (const fps of [10, 30, 60, 120]) {
    let position = 0;
    for (let i = 0; i < fps; i++) position += (10 - position) * motionBlend(7.5, 1 / fps);
    assert(Math.abs(position - 10 * (1 - Math.exp(-7.5))) < 1e-10);
  }
});

test("joint easing is independent of the scene quality frame budget", () => {
  for (const fps of [10, 30, 60, 120]) {
    let position = 0;
    for (let i = 0; i < fps; i++) position += (1 - position) * frameBlend(0.09, 1 / fps);
    assert(Math.abs(position - (1 - Math.pow(0.91, 30))) < 1e-10);
  }
  assert.equal(motionBlend(7, 0), 0);
});

test("room focus takes the short rotation after several full camera orbits", () => {
  const current = Math.PI * 8 + 0.2;
  const target = nearestAngle(-0.38, current);
  assert(Math.abs((target - current) + 0.58) < 1e-10);
  assert(Math.abs(Math.sin(target) - Math.sin(-0.38)) < 1e-10);
});

test("a touch tap activates once and an unrelated UI release never activates", () => {
  const gesture = new SceneGesture();
  assert.equal(gesture.end(3, 40, 40), false);
  gesture.start(3, 40, 40);
  assert.equal(gesture.end(3, 42, 42), true);
  assert.equal(gesture.end(3, 42, 42), false);
  assert.equal(gesture.active, false);
});

test("orbit uses touch positions and a drag returning to its start is not a tap", () => {
  const gesture = new SceneGesture();
  gesture.start(1, 20, 30);
  assert.deepEqual(gesture.move(1, 40, 45), { x: 20, y: 15, zoom: 1 });
  gesture.move(1, 20, 30);
  assert.equal(gesture.end(1, 20, 30), false);
});

test("pinch zoom does not orbit or select and remaining touch can resume orbit", () => {
  const gesture = new SceneGesture();
  gesture.start(1, 0, 0);
  gesture.start(2, 100, 0);
  assert.deepEqual(gesture.move(2, 200, 0), { x: 0, y: 0, zoom: 0.5 });
  assert.equal(gesture.end(2, 200, 0), false);
  assert.deepEqual(gesture.move(1, 10, 5), { x: 10, y: 5, zoom: 1 });
  assert.equal(gesture.end(1, 10, 5), false);
});

test("pointer cancellation clears selection and zoom remains bounded", () => {
  const gesture = new SceneGesture();
  gesture.start(1, 0, 0);
  gesture.cancel(1);
  assert.equal(gesture.end(1, 0, 0), false);
  gesture.start(1, 0, 0);
  gesture.start(2, 100, 0);
  gesture.cancel();
  assert.equal(gesture.active, false);
  assert.equal(zoomRadius(15, 0.01), 7);
  assert.equal(zoomRadius(15, 50), 32);
});
