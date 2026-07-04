/** In-browser OCR (Tesseract.js) + cleanup of the extracted text.
 *
 * Image input port: the UI hands it an image and gets back text ready to
 * segment into sentences. Everything runs client-side (WASM); no backend
 * and no new key. Tesseract downloads its worker/wasm/language data from a
 * CDN the first time, so the first read needs network access.
 *
 * Text coming out of an OCR is dirty: line breaks mid-sentence,
 * de-hyphenated words, page numbers, headers.
 * `cleanOcrText` rebuilds it into readable paragraphs; the split into
 * sentences (sub-bosses) is done afterwards by `splitSentences` in game.ts
 * (Intl.Segmenter) or by the LLM coach if configured.
 */

export interface OcrResult {
  text: string | null;
  error: string | null;
}

export async function extractTextFromImage(
  image: File | Blob,
  onProgress?: (pct: number) => void,
): Promise<OcrResult> {
  try {
    // Dynamic import: the game bundle doesn't load Tesseract (~several MB
    // of WASM) until someone actually uses an image.
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng", 1, {
      logger: (m) => {
        if (m.status === "recognizing text" && onProgress) {
          onProgress(Math.round(m.progress * 100));
        }
      },
    });
    try {
      const { data } = await worker.recognize(image);
      const text = (data.text ?? "").trim();
      if (!text) return { text: null, error: "No encontré texto en la imagen." };
      return { text, error: null };
    } finally {
      await worker.terminate();
    }
  } catch (exc) {
    return { text: null, error: `No pude leer la imagen: ${String(exc)}` };
  }
}

/** Rebuilds the OCR text into clean paragraphs:
 *  - end-of-line de-hyphenation ("inter-\nesting" -> "interesting")
 *  - joins the broken lines of a same paragraph (blocks between empty lines)
 *  - discards letterless junk (page numbers, rules, stray symbols)
 */
export function cleanOcrText(raw: string): string {
  let text = raw.replace(/\r\n?/g, "\n");
  text = text.replace(/(\p{L})-\n\s*(\p{L})/gu, "$1$2");
  const blocks = text
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    // A valid block has at least a couple of consecutive letters: out with
    // the "12", "---", "| |" the OCR invents at the edges.
    .filter((block) => /\p{L}{2}/u.test(block) && block.length >= 3);
  return blocks.join("\n");
}
