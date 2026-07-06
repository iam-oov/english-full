import { describe, expect, it } from "vitest";

import { cleanOcrText } from "./ocr";

describe("cleanOcrText", () => {
  it("re-joins words hyphenated across line breaks", () => {
    expect(cleanOcrText("The win-\ndows were cold")).toBe(
      "The windows were cold",
    );
  });

  it("joins wrapped lines of the same paragraph", () => {
    expect(cleanOcrText("The colony was\nbecoming strong")).toBe(
      "The colony was becoming strong",
    );
  });

  it("keeps paragraphs separated by blank lines", () => {
    expect(cleanOcrText("First block\n\nSecond block")).toBe(
      "First block\nSecond block",
    );
  });

  it("drops junk blocks without letters", () => {
    expect(cleanOcrText("Real text here\n\n42\n\n---")).toBe("Real text here");
  });

  it("collapses repeated whitespace", () => {
    expect(cleanOcrText("Too   many    spaces")).toBe("Too many spaces");
  });
});
