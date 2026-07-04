/** Modelo de juego — dominio puro. Espejo del modelo de `app.py`.
 *
 * Tipos de objetivo:
 *   "sentence" -> sub-jefe: una oración del párrafo (se evalúa por palabra)
 *   "boss"     -> jefe final: el párrafo completo (reconocimiento continuo)
 *   "word"     -> palabra suelta (solo en el modo práctica con R)
 */

export type Kind = "sentence" | "boss" | "word";

export interface Target {
  /** id estable: reemplaza el `id(Target)` de Python para indexar estado */
  id: number;
  /** lo que se muestra grande */
  label: string;
  /** el texto que Azure evalúa */
  reference: string;
  kind: Kind;
}

let nextTargetId = 1;

export const makeSentence = (text: string): Target => ({
  id: nextTargetId++, label: text, reference: text, kind: "sentence",
});
export const makeBoss = (paragraph: string): Target => ({
  id: nextTargetId++, label: paragraph, reference: paragraph, kind: "boss",
});
export const makeWord = (w: string): Target => ({
  id: nextTargetId++, label: w, reference: w, kind: "word",
});

/** Se evalúa por palabra (oración o jefe), no por fonema. */
export const isMultiword = (t: Target): boolean =>
  t.kind === "sentence" || t.kind === "boss";

/** Tolera pausas largas entre palabras al reconocer (oración/jefe). */
export const isLongForm = isMultiword;

/** Reconocimiento CONTINUO (sin tope de ~15s): el jefe = párrafo entero. */
export const isContinuous = (t: Target): boolean => t.kind === "boss";

/** Divide un párrafo en oraciones. Un salto de línea SIEMPRE es frontera
 * (una línea = una oración, como en el escritorio); dentro de cada línea
 * segmenta con Intl.Segmenter + re-unión de abreviaturas, en vez del split
 * naïf por '.'. Así "Mr. Smith arrived." o "Meet at 5 p.m. today." quedan
 * como UNA oración. */
export function splitSentences(text: string): string[] {
  return text.split("\n").flatMap(segmentLine);
}

/** Un segmento que termina en abreviatura NO cierra la oración: se re-une con
 * el siguiente. El ICU de los navegadores segmenta sin lista de supresiones
 * (corta en "Mr."), así que la ponemos nosotros. `\b\p{L}\.` cubre iniciales
 * y siglas con puntos ("J.", "U.S.", "p.m."). */
const ABBREV_END =
  /(?:\b(?:mr|mrs|ms|dr|prof|st|sr|jr|vs|etc|no|approx)|\b\p{L})\.$/iu;

function segmentLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    const merged: string[] = [];
    for (const { segment } of segmenter.segment(trimmed)) {
      const prev = merged[merged.length - 1];
      if (prev !== undefined && ABBREV_END.test(prev.trimEnd())) {
        merged[merged.length - 1] = prev + segment;
      } else {
        merged.push(segment);
      }
    }
    const parts = merged
      .map((s) => stripTrailingDot(s.trim()))
      .filter(Boolean);
    if (parts.length > 0) return parts;
  } catch {
    // navegador sin Intl.Segmenter: caer al split clásico por '.'
  }
  return trimmed
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** El punto final no forma parte del sub-jefe (igual que el split clásico);
 * '?' y '!' sí se conservan (cambian la entonación que se practica). */
const stripTrailingDot = (s: string): string => s.replace(/\.+$/, "").trim();

/** Sub-jefes (oraciones) + jefe final (párrafo, solo si hay más de una oración). */
export function buildTargets(sentences: string[]): Target[] {
  const targets = sentences.map(makeSentence);
  if (sentences.length > 1) {
    // Reconstrucción limpia: cada oración cierra con su propia puntuación
    // (o un '.' si no trae), sin duplicar el "?." / "!.".
    const paragraph = sentences
      .map((s) => (/[.!?…]$/.test(s) ? s : `${s}.`))
      .join(" ");
    targets.push(makeBoss(paragraph));
  }
  return targets;
}

/** Normaliza para comparar lo reconocido vs el objetivo: minúsculas, sin
 * puntuación, espacios colapsados. 'Entered.' == 'entered'. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** ÚNICA fuente de verdad de las teclas de acción. Cambiás la letra acá y se
 * actualiza en los bindings y en todas las pistas en pantalla. */
export const KEYS = {
  correct: "f", // escuchá la pronunciación CORRECTA (TTS de Azure)
  mine: "d", // escuchá TU voz (tu última grabación)
  retry: "s", // reintentar (incluso si ya la derrotaste)
  boss: "a", // toggle: ir al jefe final / volver
  practice: "r", // practicar las palabras con más errores del objetivo
  clear: "x", // reiniciar la lista de palabras a practicar del objetivo
  prev: "q", // navegar al sub-jefe/jefe ANTERIOR
  next: "w", // navegar al sub-jefe/jefe SIGUIENTE
  fontUp: "p", // agrandar la fuente del texto a leer
  fontDown: "l", // achicar la fuente
} as const;

export type KeyAction = keyof typeof KEYS;

/** Pistas para los sonidos del inglés que más cuestan a un hispanohablante.
 * Clave = fonema IPA que devuelve Azure. */
const PHONEME_HINTS: Record<string, string> = {
  "ð": "el 'th' SUAVE de THIS/THE (lengua entre los dientes, CON voz)",
  "θ": "el 'th' FUERTE de THINK/BATH (lengua entre los dientes, SIN voz)",
  v: "la 'v' de VAN (labio sobre los dientes — NO es B)",
  w: "la 'w' de WE/WATER (labios redondeados, como 'u')",
  "ɹ": "la 'r' inglesa de RED (la lengua NO vibra)",
  r: "la 'r' inglesa de RED (la lengua NO vibra)",
  "ɪ": "la 'i' CORTA y relajada de SHIP/BIT (no es la de SHEEP)",
  i: "la 'i' LARGA de SHEEP/SEE",
  "iː": "la 'i' LARGA de SHEEP/SEE",
  "æ": "la 'a' abierta de CAT/MAP (boca bien abierta)",
  "ə": "la 'schwa': vocal neutra y floja de THE/ABOUT",
  "ʌ": "la 'a' de CUP/LUCK",
  "ʃ": "el 'sh' de SHE/SHIP",
  "ʒ": "el sonido de viSIon/meaSure",
  "tʃ": "el 'ch' de CHEESE/CHAIR",
  "dʒ": "la 'j' de JOB/AGE",
  "ŋ": "el 'ng' nasal de SING/KING",
  h: "la 'h' ASPIRADA de HELLO (sí suena, no es muda)",
  "ʊ": "la 'u' corta de BOOK/PUT",
  u: "la 'u' larga de FOOD",
  "uː": "la 'u' larga de FOOD",
  "ɛ": "la 'e' de BED/HEAD",
  "ɔ": "la 'o' larga de THOUGHT/LAW",
  "ɔː": "la 'o' larga de THOUGHT/LAW",
  "ɑ": "la 'a' larga de FATHER/CAR",
  "ɑː": "la 'a' larga de FATHER/CAR",
  "eɪ": "el diptongo 'ei' de DAY/FACE",
  "oʊ": "el diptongo 'ou' de GO/HOME",
};

/** Pista para un fonema IPA; tolera marcas de longitud (ː) y variantes. */
export function phonemeHint(phoneme: string): string | null {
  return (
    PHONEME_HINTS[phoneme] ?? PHONEME_HINTS[phoneme.replace(/ː/g, "")] ?? null
  );
}
