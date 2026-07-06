import { describe, expect, it } from "vitest";

import { RED_CUTOFF, assessmentUnits, judge, judgeAssessment, redCount } from "./scoring";
import type { Assessment, WordScore } from "./types";

const w = (word: string, accuracy: number, errorType = "None"): WordScore => ({
  word,
  accuracy,
  errorType,
  phonemes: [],
});

const assessment = (words: WordScore[], accuracy: number): Assessment => ({
  recognizedText: "",
  accuracy,
  pronunciation: accuracy,
  completeness: 100,
  fluency: 90,
  words,
  error: null,
  audioUrl: null,
});

describe("judge", () => {
  it("passes when the average clears the bar and nothing is red", () => {
    const v = judge([["a", 78], ["b", 95]], { accuracy: 88, threshold: 85 });
    expect(v.passed).toBe(true);
    expect(v.worstLabel).toBe("a");
  });

  it("a red unit vetoes even a high average", () => {
    const v = judge([["a", 49], ["b", 99]], { accuracy: 90, threshold: 85 });
    expect(v.passed).toBe(false);
    expect(v.worstScore).toBe(49);
  });

  it("an average below the bar fails even with no reds", () => {
    expect(judge([["a", 80]], { accuracy: 80, threshold: 85 }).passed).toBe(false);
  });

  it("boundary: RED_CUTOFF itself is not red; threshold itself passes", () => {
    const v = judge([["a", RED_CUTOFF]], { accuracy: 85, threshold: 85 });
    expect(v.passed).toBe(true);
  });

  it("falls back to the average when there is no breakdown", () => {
    expect(judge([], { accuracy: 86, threshold: 85 }).passed).toBe(true);
    expect(judge([], { accuracy: 84, threshold: 85 }).passed).toBe(false);
  });
});

describe("assessmentUnits", () => {
  it("excludes insertions from sentence units", () => {
    const a = assessment([w("uh", 0, "Insertion"), w("the", 90), w("crop", 80)], 85);
    expect(assessmentUnits(a, true)).toEqual([
      ["the", 90],
      ["crop", 80],
    ]);
  });

  it("uses the first word's phonemes for drills", () => {
    const a = assessment(
      [{ ...w("crop", 70), phonemes: [{ phoneme: "k", accuracy: 40 }] }],
      70,
    );
    expect(assessmentUnits(a, false)).toEqual([["k", 40]]);
  });
});

describe("judgeAssessment / redCount", () => {
  it("an inserted echo cannot veto the win", () => {
    const a = assessment(
      [w("hello", 96), w("world", 95), w("hello", 0, "Insertion")],
      95,
    );
    expect(judgeAssessment(a, true, 85).passed).toBe(true);
    expect(redCount(a, true)).toBe(0);
  });

  it("counts reds below the cutoff only", () => {
    const a = assessment([w("a", 49), w("b", 50), w("c", 84)], 61);
    expect(redCount(a, true)).toBe(1);
  });
});
