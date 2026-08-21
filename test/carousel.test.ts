// Run with: npm test
//
// Covers the carousel's face list: which faces a key shows, in what order,
// where it starts and how long each one holds. The failure modes here are
// silent — a key that quietly shows the wrong window, or one that rotates when
// it was meant to stay put — so the defaults and the fallbacks are the point.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FACE_ORDER,
  carouselAuto,
  faceCount,
  faceOrder,
  faceSec,
  startFace,
} from "../src/usage-core";

const ids = (s: Parameters<typeof faceOrder>[0]) => faceOrder(s).map((f) => f.id);

describe("carousel face order", () => {
  test("a key with no face setting keeps the original pairing", () => {
    // Keys configured before this setting existed must not change behaviour.
    assert.deepEqual(ids({}), DEFAULT_FACE_ORDER);
    assert.deepEqual(ids({ faceOrder: "" }), DEFAULT_FACE_ORDER);
    assert.deepEqual(ids({ faceOrder: "   " }), DEFAULT_FACE_ORDER);
  });

  test("faces rotate in the order they were given", () => {
    assert.deepEqual(ids({ faceOrder: "weekly,session" }), ["weekly", "session"]);
    assert.deepEqual(ids({ faceOrder: "badge,model_weekly" }), ["badge", "model_weekly"]);
    assert.deepEqual(ids({ faceOrder: " session , badge " }), ["session", "badge"]);
  });

  test("a single face is a valid carousel", () => {
    assert.deepEqual(ids({ faceOrder: "weekly" }), ["weekly"]);
    assert.equal(faceCount({ faceOrder: "weekly" }), 1);
  });

  test("repeats and unknown ids are dropped", () => {
    assert.deepEqual(ids({ faceOrder: "session,session,weekly" }), ["session", "weekly"]);
    assert.deepEqual(ids({ faceOrder: "bogus,weekly" }), ["weekly"]);
  });

  test("a key with nothing valid still draws something", () => {
    // Every face switched off would otherwise paint an empty key.
    assert.deepEqual(ids({ faceOrder: "bogus" }), ["session"]);
  });
});

describe("carousel starting face", () => {
  test("the start is an index into this key's own order", () => {
    assert.equal(startFace({ faceOrder: "weekly,session", carouselStart: "session" }), 1);
    assert.equal(startFace({ faceOrder: "weekly,session", carouselStart: "weekly" }), 0);
  });

  test("starting on a face that isn't shown falls back to the first", () => {
    assert.equal(startFace({ faceOrder: "session,weekly", carouselStart: "badge" }), 0);
    assert.equal(startFace({}), 0);
  });
});

describe("carousel timing", () => {
  test("metric faces share the interval, the badge overrides it", () => {
    const s = { faceOrder: "session,badge", carouselSec: 8, badgeSec: 2 };
    assert.equal(faceSec(s, 0), 8);
    assert.equal(faceSec(s, 1), 2);
  });

  test("the badge defaults to a short dwell", () => {
    assert.equal(faceSec({ faceOrder: "badge" }, 0), 3);
  });

  test("dwell never reaches zero", () => {
    // A zero delay would spin the rotation as fast as the event loop allows.
    assert.equal(faceSec({ faceOrder: "badge", badgeSec: 0 }, 0), 1);
    assert.equal(faceSec({ faceOrder: "badge", badgeSec: 999999 }, 0), 3600);
  });

  test("interval 0 is the slider's own 'never switch' position", () => {
    assert.equal(carouselAuto({ carouselSec: 0 }), false);
    assert.equal(carouselAuto({ carouselSec: "0" as unknown as number }), false);
    assert.equal(carouselAuto({ carouselSec: 10 }), true);
  });

  test("auto-rotate is on by default and off when unticked", () => {
    assert.equal(carouselAuto({}), true);
    assert.equal(carouselAuto({ carouselAuto: false }), false);
    // sdpi hands checkbox values back as strings.
    assert.equal(carouselAuto({ carouselAuto: "false" as unknown as boolean }), false);
  });
});
