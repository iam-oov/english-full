import { beforeEach, describe, expect, it } from "vitest";

import { clearRun, loadRun, saveRun, type SavedRun } from "./run";

const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const run = (over: Partial<SavedRun> = {}): SavedRun => ({
  sentences: ["First one", "Second one"],
  index: 1,
  status: ["defeated", null, null],
  bestHp: [97, 0, 0],
  errors: [{}, { second: 2 }, {}],
  streak: 1,
  combo: 3,
  runXp: 40,
  totalAttempts: 2,
  wordAttempts: 1,
  screen: "fail",
  assessment: null,
  ...over,
});

beforeEach(() => store.clear());

describe("run persistence", () => {
  it("round-trips a saved run", () => {
    saveRun(run());
    expect(loadRun()).toEqual(run());
  });

  it("returns null when nothing is saved or after clearRun", () => {
    expect(loadRun()).toBeNull();
    saveRun(run());
    clearRun();
    expect(loadRun()).toBeNull();
  });

  it("rejects corrupted JSON", () => {
    store.set("pronunciation-tetris.run", "{not json");
    expect(loadRun()).toBeNull();
  });

  it("rejects per-target arrays that do not match the target count", () => {
    saveRun(run({ status: ["defeated", null] }));
    expect(loadRun()).toBeNull();
    saveRun(run({ bestHp: [97] }));
    expect(loadRun()).toBeNull();
    saveRun(run({ errors: [{}, {}, {}, {}] }));
    expect(loadRun()).toBeNull();
  });

  it("a single sentence expects no boss slot", () => {
    saveRun(
      run({ sentences: ["Only one"], status: [null], bestHp: [0], errors: [{}] }),
    );
    expect(loadRun()).not.toBeNull();
  });

  it("defaults unknown view fields instead of failing", () => {
    const saved = run();
    const raw = JSON.parse(JSON.stringify(saved));
    delete raw.screen;
    delete raw.wordAttempts;
    store.set("pronunciation-tetris.run", JSON.stringify(raw));
    const loaded = loadRun();
    expect(loaded?.screen).toBe("ready");
    expect(loaded?.wordAttempts).toBe(0);
  });

  it("clamps an out-of-range index", () => {
    saveRun(run({ index: 99 }));
    expect(loadRun()?.index).toBe(2);
    saveRun(run({ index: -3 }));
    expect(loadRun()?.index).toBe(0);
  });

  it("counts gauntlet slots in the positional contract", () => {
    const sentences = ["s1", "s2", "s3", "s4", "s5"];
    // 5 sentences + 1 gauntlet (after the 4th) + boss = 7 slots.
    const seven = {
      status: Array(7).fill(null),
      bestHp: Array(7).fill(0),
      errors: Array(7).fill({}),
    };
    saveRun(run({ sentences, index: 0, ...seven }));
    expect(loadRun()).not.toBeNull();
    saveRun(
      run({
        sentences,
        index: 0,
        status: Array(6).fill(null),
        bestHp: Array(6).fill(0),
        errors: Array(6).fill({}),
      }),
    );
    expect(loadRun()).toBeNull();
  });
});
