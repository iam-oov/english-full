"""Adapter de DeepSeek (LLM): consejos de pronunciacion personalizados.

Frontera (como scorer.py con Azure): el juego pide "dame un consejo" y NO sabe
que abajo hay DeepSeek. La API de DeepSeek es compatible con la de OpenAI
(chat/completions), asi que hablamos por HTTP plano.

tip() devuelve None si algo falla (sin key, red caida, respuesta rara) -> el
caller cae a la pista estatica. Si no hay DEEPSEEK_API_KEY, available=False y
nunca se llama. Cero regresion si DeepSeek no esta.
"""

from __future__ import annotations

import requests

from config import Config

_TIMEOUT = 20  # segundos


class Coach:
    def __init__(self, config: Config) -> None:
        self._config = config

    @property
    def available(self) -> bool:
        return self._config.coach_enabled

    def _chat(
        self, system: str, user: str, json_mode: bool = False, temperature: float = 0.3
    ) -> str | None:
        """Una vuelta de chat con DeepSeek. Devuelve el texto o None si falla."""
        if not self.available:
            return None
        try:
            body = {
                "model": self._config.deepseek_model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "stream": False,
                "temperature": temperature,
            }
            if json_mode:
                body["response_format"] = {"type": "json_object"}
            resp = requests.post(
                f"{self._config.deepseek_base_url.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self._config.deepseek_key}",
                    "Content-Type": "application/json",
                },
                json=body,
                timeout=_TIMEOUT,
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
        except Exception:
            return None

    def tip(
        self,
        word: str,
        phonemes: list[tuple[str, float]],
        recognized: str,
        word_attempts: int = 1,
        total_attempts: int = 1,
        level: str = "B2",
    ) -> str | None:
        """Consejo corto (en espanol) para mejorar los sonidos mas flojos.

        Recibe cuantos intentos lleva con ESTA palabra y en total, para variar el
        enfoque y no repetir siempre lo mismo. 'level' = nivel CEFR del alumno.
        """
        system = (
            f"Sos un profesor de pronunciacion de ingles para un hispanohablante "
            f"de nivel {level} (CEFR). Hablas en espanol rioplatense, calido y "
            "directo. Tus consejos son cortos, concretos y accionables, y NUNCA "
            "repetis el mismo consejo: cada vez probas un angulo distinto."
        )
        detalle = ", ".join(f"{ph} {score:.0f}%" for ph, score in phonemes) or "s/d"
        user = (
            f'La palabra objetivo es "{word}". El alumno la pronuncio con estos '
            f"scores por fonema (IPA, 0-100): {detalle}. "
            f'El reconocedor de voz escucho: "{recognized}". '
            f"Lleva {word_attempts} intento(s) con ESTA palabra y "
            f"{total_attempts} en toda la sesion.\n"
            "Dale UN consejo corto (maximo 2 frases) enfocado SOLO en el/los "
            "sonido(s) mas flojo(s): como posicionar boca/lengua y una palabra de "
            "practica. IMPORTANTE: si ya lleva varios intentos con esta palabra, "
            "CAMBIA el enfoque (no repitas): proba con un par minimo, una analogia "
            "con un sonido del espanol, un truco fisico distinto, u otra palabra de "
            "practica. Sin saludos ni introducciones, directo al consejo."
        )
        content = self._chat(system, user, temperature=0.85)
        return content.strip() if content else None
