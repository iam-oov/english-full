"""Tests del modelo de objetivos: el enum Kind y los named constructors.

El tipo de objetivo dejo de ser un string magico ("sentence"/"boss"/"word")
para ser un Kind. La construccion se centraliza en factory methods
(Target.sentence/.boss/.word) en vez de pasar kind a mano en cada call site.
"""

from __future__ import annotations

from app import Game, Kind, Target


def test_kind_has_three_members():
    assert {k.value for k in Kind} == {"sentence", "boss", "word"}


def test_named_constructors_set_kind_and_text():
    s = Target.sentence("Hello there")
    assert s.kind is Kind.SENTENCE
    assert s.label == "Hello there"
    assert s.reference == "Hello there"

    b = Target.boss("A. B.")
    assert b.kind is Kind.BOSS

    w = Target.word("the")
    assert w.kind is Kind.WORD
    assert w.label == "the"


def test_recognition_behavior_lives_on_target():
    # Cada tipo sabe como debe reconocerse, sin que app.py lo deduzca afuera.
    s = Target.sentence("a b c")
    assert s.is_multiword is True
    assert s.long_form is True       # tolera pausas largas (varias palabras)
    assert s.continuous is False     # recognize_once alcanza para una oracion

    b = Target.boss("a. b.")
    assert b.is_multiword is True
    assert b.long_form is True
    assert b.continuous is True      # parrafo entero -> reconocimiento continuo

    w = Target.word("the")
    assert w.is_multiword is False
    assert w.long_form is False
    assert w.continuous is False


def test_single_sentence_has_no_boss():
    g = Game(["Just one sentence"])
    assert len(g.targets) == 1
    assert g.targets[0].kind is Kind.SENTENCE


def test_multiple_sentences_append_boss_paragraph():
    g = Game(["First one", "Second one"])
    assert [t.kind for t in g.targets] == [Kind.SENTENCE, Kind.SENTENCE, Kind.BOSS]
    # El jefe reconstruye el parrafo limpio desde las oraciones.
    assert g.targets[-1].reference == "First one. Second one."
