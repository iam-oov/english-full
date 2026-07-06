import { describe, expect, it } from "vitest";

import { buildTargets, failHint, normalizeText, splitSentences } from "./game";
import type { Assessment, WordScore } from "./types";

const w = (word: string, accuracy: number): WordScore => ({
  word,
  accuracy,
  errorType: "None",
  phonemes: [],
});

const assessment = (over: Partial<Assessment>): Assessment => ({
  recognizedText: "",
  accuracy: 70,
  pronunciation: 70,
  completeness: 90,
  fluency: 88,
  words: [],
  error: null,
  audioUrl: null,
  ...over,
});

describe("splitSentences", () => {
  it("treats every newline as a boundary", () => {
    expect(splitSentences("One two\nThree four")).toEqual([
      "One two",
      "Three four",
    ]);
  });

  it("segments within a line and strips the trailing period", () => {
    expect(splitSentences("It was cold. Nobody spoke.")).toEqual([
      "It was cold",
      "Nobody spoke",
    ]);
  });

  it("does not break on abbreviations", () => {
    expect(splitSentences("Mr. Smith arrived. It was 5 p.m. today.")).toEqual([
      "Mr. Smith arrived",
      "It was 5 p.m. today",
    ]);
  });

  it("keeps ? and ! as part of the sentence", () => {
    expect(splitSentences("Really? Yes! Fine.")).toEqual([
      "Really?",
      "Yes!",
      "Fine",
    ]);
  });

  it("ignores blank lines", () => {
    expect(splitSentences("A.\n\n\nB.")).toEqual(["A", "B"]);
  });
});

describe("buildTargets", () => {
  it("adds a boss only when there is more than one sentence", () => {
    expect(buildTargets(["Only one"]).map((t) => t.kind)).toEqual(["sentence"]);
    const multi = buildTargets(["First", "Second?"]);
    expect(multi.map((t) => t.kind)).toEqual(["sentence", "sentence", "boss"]);
    expect(multi[2]!.reference).toBe("First. Second?");
  });
});

describe("normalizeText", () => {
  it("compares case- and punctuation-insensitively", () => {
    expect(normalizeText("Entered.")).toBe(normalizeText("entered"));
    expect(normalizeText("The crop,  was  saved")).toBe("the crop was saved");
  });
});

describe("failHint", () => {
  it("sentences with weak words defer to the inline breakdown", () => {
    const a = assessment({ words: [w("crop", 40)] });
    expect(failHint(a, true, 85)).toBe("");
  });

  it("sentences with no weak words report completeness and fluency", () => {
    const a = assessment({ words: [w("crop", 95)], completeness: 90, fluency: 88 });
    expect(failHint(a, true, 85)).toContain("Completaste 90%");
  });

  it("drills point at the weakest phoneme with its hint", () => {
    const a = assessment({
      words: [
        {
          word: "this",
          accuracy: 60,
          errorType: "None",
          phonemes: [
            { phoneme: "ð", accuracy: 30 },
            { phoneme: "s", accuracy: 90 },
          ],
        },
      ],
    });
    const hint = failHint(a, false, 85);
    expect(hint).toContain("[ð]");
    expect(hint).toContain("30%");
    expect(hint).toContain("th");
  });
});
