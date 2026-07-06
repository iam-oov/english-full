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
  badgeText: "",
  badgeTone: "c-dim",
  resultStyle: "idle",
  feedbackText: "",
  feedbackTone: "c-muted",
  practice: null,
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
    raw.feedbackTone = 42;
    store.set("pronunciation-tetris.run", JSON.stringify(raw));
    const loaded = loadRun();
    expect(loaded?.screen).toBe("ready");
    expect(loaded?.wordAttempts).toBe(0);
    expect(loaded?.feedbackTone).toBe("c-muted");
  });

  it("drops a malformed practice block but keeps the run", () => {
    saveRun(run({ practice: { origin: 0, words: [1, 2], pos: 0 } as never }));
    const loaded = loadRun();
    expect(loaded).not.toBeNull();
    expect(loaded?.practice).toBeNull();
  });
});
