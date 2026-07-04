/** OCR en el navegador (Tesseract.js) + limpieza del texto extraído.
 *
 * Puerto de entrada de imágenes: la UI le da una imagen y recibe texto listo
 * para segmentar en oraciones. Todo corre client-side (WASM); no hay backend
 * ni key nueva. Tesseract descarga su worker/wasm/datos de idioma de un CDN
 * la primera vez, así que la primera lectura necesita red.
 *
 * El texto que sale de un OCR viene sucio: cortes de línea a mitad de
 * oración, palabras des-guionadas, números de página, encabezados.
 * `cleanOcrText` lo reconstruye en párrafos legibles; la división en
 * oraciones (sub-jefes) la hace después `splitSentences` de game.ts
 * (Intl.Segmenter) o el coach LLM si está configurado.
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
    // Import dinámico: el bundle del juego no carga Tesseract (~varios MB de
    // WASM) hasta que alguien realmente usa una imagen.
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

/** Reconstruye el texto OCR en párrafos limpios:
 *  - des-guionado de fin de línea ("inter-\nesting" -> "interesting")
 *  - une las líneas cortadas de un mismo párrafo (bloques entre líneas vacías)
 *  - descarta basura sin letras (números de página, reglas, símbolos sueltos)
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
    // Un bloque válido tiene al menos un par de letras seguidas: afuera los
    // "12", "---", "| |" que el OCR inventa en los bordes.
    .filter((block) => /\p{L}{2}/u.test(block) && block.length >= 3);
  return blocks.join("\n");
}
