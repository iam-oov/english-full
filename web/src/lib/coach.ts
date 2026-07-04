/** Adapter de DeepSeek (LLM): consejos de pronunciación personalizados.
 * Espejo de `coach.py`: opcional y sin regresión. `tip()` devuelve null si algo
 * falla (sin key, red caída, CORS) -> el caller cae a la pista estática.
 *
 * OJO navegador: la API de DeepSeek no manda cabeceras CORS, así que el fetch
 * directo puede fallar según el navegador/red. Se degrada solo: catch -> null.
 */

import type { Settings } from "./config";
import { coachEnabled } from "./config";

const TIMEOUT_MS = 20_000;

export class Coach {
  constructor(private settings: Settings) {}

  get available(): boolean {
    return coachEnabled(this.settings);
  }

  private async chat(
    system: string,
    user: string,
    temperature = 0.3,
    jsonMode = false,
  ): Promise<string | null> {
    if (!this.available) return null;
    try {
      const base = this.settings.deepseekBaseUrl.replace(/\/+$/, "");
      const resp = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.deepseekKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.settings.deepseekModel,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          stream: false,
          temperature,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return data?.choices?.[0]?.message?.content ?? null;
    } catch {
      return null;
    }
  }

  /** Consejo corto (en español) para mejorar los sonidos más flojos. */
  async tip(
    word: string,
    phonemes: Array<[string, number]>,
    recognized: string,
    wordAttempts = 1,
    totalAttempts = 1,
    level = "B2",
  ): Promise<string | null> {
    const system =
      `Sos un profesor de pronunciacion de ingles para un hispanohablante ` +
      `de nivel ${level} (CEFR). Hablas en espanol rioplatense, calido y ` +
      `directo. Tus consejos son cortos, concretos y accionables, y NUNCA ` +
      `repetis el mismo consejo: cada vez probas un angulo distinto.`;
    const detalle =
      phonemes.map(([ph, score]) => `${ph} ${score.toFixed(0)}%`).join(", ") ||
      "s/d";
    const user =
      `La palabra objetivo es "${word}". El alumno la pronuncio con estos ` +
      `scores por fonema (IPA, 0-100): ${detalle}. ` +
      `El reconocedor de voz escucho: "${recognized}". ` +
      `Lleva ${wordAttempts} intento(s) con ESTA palabra y ` +
      `${totalAttempts} en toda la sesion.\n` +
      `Dale UN consejo corto (maximo 2 frases) enfocado SOLO en el/los ` +
      `sonido(s) mas flojo(s): como posicionar boca/lengua y una palabra de ` +
      `practica. IMPORTANTE: si ya lleva varios intentos con esta palabra, ` +
      `CAMBIA el enfoque (no repitas): proba con un par minimo, una analogia ` +
      `con un sonido del espanol, un truco fisico distinto, u otra palabra de ` +
      `practica. Sin saludos ni introducciones, directo al consejo.`;
    const content = await this.chat(system, user, 0.85);
    return content ? content.trim() : null;
  }

  /** Limpia texto salido de un OCR y lo divide en oraciones listas para jugar
   * (sub-jefes). Devuelve null si algo falla -> el caller cae a la heurística
   * local (cleanOcrText + Intl.Segmenter), mismo contrato que tip(). */
  async smartSplit(rawText: string): Promise<string[] | null> {
    const system =
      "Sos un asistente que prepara texto en ingles, extraido por OCR de una " +
      "imagen, para un juego de practica de pronunciacion. Respondes SOLO " +
      "JSON valido.";
    const user =
      "Este texto salio de un OCR y puede traer errores tipicos (lineas " +
      "cortadas, guiones, caracteres confundidos, encabezados o numeros de " +
      "pagina metidos en el medio):\n" +
      `"""\n${rawText}\n"""\n` +
      'Devolveme SOLO un objeto JSON {"sentences": ["...", "..."]} con las ' +
      "oraciones del texto principal, limpias y en orden de lectura: " +
      "corregi los errores obvios de OCR, uni las lineas partidas, y descarta " +
      "encabezados, pies de pagina y numeros sueltos. NO traduzcas, NO " +
      "resumas, NO inventes texto que no este.";
    const content = await this.chat(system, user, 0.1, true);
    if (!content) return null;
    try {
      const data = JSON.parse(content);
      const sentences = Array.isArray(data?.sentences)
        ? data.sentences.filter((s: unknown) => typeof s === "string" && s.trim())
        : [];
      return sentences.length > 0
        ? sentences.map((s: string) => s.trim())
        : null;
    } catch {
      return null;
    }
  }
}
