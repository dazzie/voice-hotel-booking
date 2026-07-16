"""Session-level language routing for the Aurora hotel agent."""

from __future__ import annotations

from dataclasses import dataclass


LANGUAGES = {
    "en": {"name": "English", "locale": "en-US"},
    "es": {"name": "Spanish", "locale": "es-ES"},
}

_SPANISH_MARKERS = {
    "espanol", "español", "hola", "habitacion", "habitación", "reserva",
    "reservar", "gracias", "noches", "personas", "quiero", "necesito",
    "puedes", "puede", "hablar", "cancelacion", "cancelación",
}

_ENGLISH_SWITCHES = (
    "speak english", "switch to english", "in english", "english please",
)
_SPANISH_SWITCHES = (
    "speak spanish", "switch to spanish", "in spanish", "spanish please",
    "habla español", "hable español", "en español",
)


@dataclass(frozen=True)
class Route:
    language: str
    locale: str
    changed: bool
    reason: str


class AgentRouter:
    """Keep a stable language choice and support explicit mid-call switching."""

    def __init__(self, default_language: str = "en"):
        self.language = default_language if default_language in LANGUAGES else "en"

    def route(self, text: str) -> Route:
        normalized = text.lower().strip()
        previous = self.language
        reason = "session"

        if any(phrase in normalized for phrase in _SPANISH_SWITCHES):
            self.language = "es"
            reason = "explicit_switch"
        elif any(phrase in normalized for phrase in _ENGLISH_SWITCHES):
            self.language = "en"
            reason = "explicit_switch"
        else:
            words = {word.strip(".,!?;:\"'()") for word in normalized.split()}
            spanish_score = len(words & _SPANISH_MARKERS)
            if spanish_score >= 2:
                self.language = "es"
                reason = "language_markers"

        config = LANGUAGES[self.language]
        return Route(
            language=self.language,
            locale=config["locale"],
            changed=self.language != previous,
            reason=reason,
        )

    def instruction(self) -> str:
        name = LANGUAGES[self.language]["name"]
        return (
            f"Current response language: {name}. Respond only in {name}. "
            "Keep hotel names, room names, prices, email addresses, and confirmation IDs unchanged."
        )
