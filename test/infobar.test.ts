// Run with: npm test
//
// Covers the Stream Deck Neo infobar: what each face draws given its toggles,
// which windows the summary face lays out, and when a window crossing Red pulls the
// carousel to its face. The strip takes no input, so a wrong default here is
// one the user can't tap their way out of.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FACES,
  alertJump,
  faceOrder,
  infobarShow,
  jumpHoldSec,
  summaryFaces,
  svgInfobar,
  svgInfobarSummary,
} from "../src/usage-core";

const ALL_ON = { icon: true, bar: true, countdown: true, dots: true };
const face = (over: Partial<Parameters<typeof svgInfobar>[0]> = {}) =>
  svgInfobar({
    label: "5 HOURS",
    pct: 42,
    note: "2h 10m",
    col: "#f0abfc",
    stale: false,
    face: 0,
    faces: 2,
    accent: "#e879f9",
    icon: "clock",
    noteCol: "#f5d0fe",
    show: ALL_ON,
    ...over,
  });
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("infobar layout", () => {
  test("the layout file is one pixmap covering the 232x50 strip", () => {
    const layout = JSON.parse(
      readFileSync(new URL("../com.saeedkolivand.claude-usage.sdPlugin/layouts/infobar.json", import.meta.url), "utf8"),
    );
    assert.equal(layout.controller, "Neo");
    assert.deepEqual(
      layout.items.map((i: any) => [i.key, i.type, i.rect]),
      [["canvas", "pixmap", [0, 0, 232, 50]]],
    );
  });
});

describe("infobar number face", () => {
  test("draws at the strip's size with the percentage", () => {
    const svg = face();
    assert.match(svg, /viewBox="0 0 232 50"/);
    assert.match(svg, />42<tspan[^>]*>%<\/tspan>/);
    assert.match(svg, />5 HOURS</);
    assert.match(svg, />2h 10m</);
  });

  test("every element can be switched off on its own", () => {
    assert.equal(count(face(), 'r="2"'), 2); // one page dot per face
    assert.equal(count(face({ show: { ...ALL_ON, dots: false } }), 'r="2"'), 0);
    assert.match(face(), /#2a313d/); // bar track
    assert.doesNotMatch(face({ show: { ...ALL_ON, bar: false } }), /#2a313d/);
    assert.doesNotMatch(face({ show: { ...ALL_ON, countdown: false } }), /2h 10m/);
    assert.match(face(), /<g transform/); // the clock icon
    assert.doesNotMatch(face({ show: { ...ALL_ON, icon: false } }), /<g transform/);
  });

  test("without the icon the label takes its place", () => {
    assert.match(face({ show: { ...ALL_ON, icon: false } }), /<text x="84" y="14"/);
  });

  test("no data shows dashes, stale data turns the countdown amber", () => {
    const none = face({ pct: null, note: "open Claude" });
    assert.match(none, />--</);
    assert.doesNotMatch(none, /<tspan/);
    assert.match(face({ stale: true }), /fill="#f59e0b">2h 10m</);
  });

  test("a single face shows no page dots", () => {
    assert.equal(count(face({ faces: 1 }), 'r="2"'), 0);
  });
});

describe("infobar summary face", () => {
  const col = (label: string, pct: number | null) => ({
    label, pct, note: "2h 10m", col: "#f0abfc", stale: false, accent: "#e879f9", icon: "clock" as const, noteCol: "#f5d0fe",
  });
  const cols = [col("5 HOURS", 42), col("WEEKLY", null), col("FABLE", 100)];

  test("one column per ticked window, -- when a window has no data", () => {
    const svg = svgInfobarSummary({ show: ALL_ON, cols });
    assert.match(svg, />5 HOURS</);
    assert.match(svg, />42<tspan[^>]*>%</);
    assert.match(svg, />--</);
    assert.match(svg, />100<tspan[^>]*>%</);
    assert.equal(count(svg, 'width="1" height="34"'), 2); // dividers between three columns
    assert.equal(count(svgInfobarSummary({ show: ALL_ON, cols: cols.slice(0, 2) }), 'width="1" height="34"'), 1);
  });

  test("columns split the strip evenly", () => {
    assert.match(svgInfobarSummary({ show: ALL_ON, cols: cols.slice(0, 2) }), /<rect x="115.5" y="8" width="1"/);
  });

  test("bar and icon follow the same switches as the number faces", () => {
    assert.match(svgInfobarSummary({ show: ALL_ON, cols }), /#2a313d/);
    assert.doesNotMatch(svgInfobarSummary({ show: { ...ALL_ON, bar: false }, cols: cols.slice(0, 1) }), /#2a313d/);
    assert.doesNotMatch(svgInfobarSummary({ show: { ...ALL_ON, icon: false }, cols }), /<g transform/);
  });

  test("no window ticked leaves the plugin's mark rather than an empty strip", () => {
    assert.match(svgInfobarSummary({ show: ALL_ON, cols: [] }), /stroke="#d97757"/);
  });
});

describe("infobar settings", () => {
  test("every element is on by default, and sdpi's string 'false' turns one off", () => {
    assert.deepEqual(infobarShow({}), ALL_ON);
    assert.deepEqual(infobarShow({ infoBar: "false" as unknown as boolean }), { ...ALL_ON, bar: false });
  });

  test("the summary covers 5h and weekly by default; the model window is opt-in", () => {
    const ids = (s: Parameters<typeof summaryFaces>[0]) => summaryFaces(s).map((f) => f.id);
    assert.deepEqual(ids({}), ["session", "weekly"]);
    assert.deepEqual(ids({ infoSumModel: true }), ["session", "weekly", "model_weekly"]);
    assert.deepEqual(ids({ infoSumSession: false, infoSumWeekly: false }), []);
  });
});

describe("infobar alert jump", () => {
  const order = faceOrder({ faceOrder: "badge,session,weekly" });

  test("a window crossing Red pulls the carousel to its face, once", () => {
    const latch = new Map<string, boolean>();
    assert.equal(alertJump(order, { session: 50, weekly: 50 }, 80, latch, "k:"), null);
    assert.equal(alertJump(order, { session: 50, weekly: 85 }, 80, latch, "k:"), 2);
    assert.equal(alertJump(order, { session: 50, weekly: 90 }, 80, latch, "k:"), null); // still Red
  });

  test("it re-arms once the window drops back below Red", () => {
    const latch = new Map<string, boolean>();
    alertJump(order, { session: 85 }, 80, latch, "k:");
    alertJump(order, { session: 0 }, 80, latch, "k:"); // window reset
    assert.equal(alertJump(order, { session: 81 }, 80, latch, "k:"), 1);
  });

  test("two windows crossing together: the first in rotation order wins", () => {
    assert.equal(alertJump(order, { session: 90, weekly: 90 }, 80, new Map(), "k:"), 1);
  });

  test("a window outside the rotation never jumps", () => {
    assert.equal(alertJump(order, { model_weekly: 99 }, 80, new Map(), "k:"), null);
  });

  test("the hold lasts one interval, and 'never' still holds long enough to read", () => {
    assert.equal(jumpHoldSec({ carouselSec: 15 }), 15);
    assert.equal(jumpHoldSec({}), 10);
    assert.equal(jumpHoldSec({ carouselSec: 0 }), 10);
  });
});

test("the summary can name every number face", () => {
  // A face added to FACES without a summary toggle would silently never show.
  const numbers = FACES.filter((f) => f.metric).map((f) => f.id);
  assert.deepEqual(
    summaryFaces({ infoSumModel: true }).map((f) => f.id),
    numbers,
  );
});
