import { describe, expect, it } from "vitest";

import { alignWords } from "./align";
import type { WordScore } from "./types";

const w = (word: string, accuracy = 90, errorType = "None"): WordScore => ({
  word,
  accuracy,
  errorType,
  phonemes: [],
});

describe("alignWords", () => {
  it("matches reference tokens in order, keeping punctuation outside", () => {
    const { tokens, insertions } = alignWords("Hello, world!", [
      w("hello", 95),
      w("world", 80),
    ]);
    expect(insertions).toEqual([]);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({ clean: "Hello", suffix: ",", omitted: false });
    expect(tokens[0]!.score?.accuracy).toBe(95);
    expect(tokens[1]).toMatchObject({ clean: "world", suffix: "!" });
  });

  it("routes insertions aside without consuming reference tokens", () => {
    const { tokens, insertions } = alignWords("the crop", [
      w("uh", 0, "Insertion"),
      w("the", 92),
      w("crop", 88),
    ]);
    expect(insertions.map((x) => x.word)).toEqual(["uh"]);
    expect(tokens[0]!.score?.word).toBe("the");
    expect(tokens[1]!.score?.word).toBe("crop");
  });

  it("marks omissions in place", () => {
    const { tokens } = alignWords("never faced starvation", [
      w("never", 96),
      w("faced", 0, "Omission"),
      w("starvation", 70),
    ]);
    expect(tokens[1]).toMatchObject({ clean: "faced", omitted: true });
    expect(tokens[2]!.score?.accuracy).toBe(70);
  });

  it("collapses apostrophes so don't matches dont", () => {
    const { tokens } = alignWords("don't stop", [w("dont", 91), w("stop", 93)]);
    expect(tokens[0]!.score?.accuracy).toBe(91);
  });

  it("joins a hyphenated token that Azure split in two, scoring the weakest half", () => {
    const { tokens } = alignWords("a well-known fact", [
      w("a", 99),
      w("well", 95),
      w("known", 60, "Mispronunciation"),
      w("fact", 97),
    ]);
    expect(tokens[1]!.clean).toBe("well-known");
    expect(tokens[1]!.score?.accuracy).toBe(60);
    expect(tokens[1]!.score?.errorType).toBe("Mispronunciation");
    expect(tokens[2]!.score?.word).toBe("fact");
  });

  it("never mis-highlights: an unmatched token gets score null and does not advance", () => {
    const { tokens } = alignWords("one 5 two", [w("one", 90), w("two", 85)]);
    expect(tokens[0]!.score?.word).toBe("one");
    expect(tokens[1]!.score).toBeNull();
    expect(tokens[2]!.score?.word).toBe("two");
  });

  it("resyncs within the lookahead window after service noise", () => {
    const { tokens } = alignWords("alpha beta gamma", [
      w("noise", 10),
      w("alpha", 90),
      w("beta", 91),
      w("gamma", 92),
    ]);
    expect(tokens.map((t) => t.score?.word)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("handles empty results: every token unscored", () => {
    const { tokens, insertions } = alignWords("a b c", []);
    expect(insertions).toEqual([]);
    expect(tokens.every((t) => t.score === null)).toBe(true);
  });

  it("punctuation-only tokens stay plain", () => {
    const { tokens } = alignWords("wait — go", [w("wait", 90), w("go", 92)]);
    expect(tokens[1]!.clean).toBe("");
    expect(tokens[1]!.score).toBeNull();
  });
});
