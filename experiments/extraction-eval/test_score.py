#!/usr/bin/env python3
"""Deterministic tests for the scoring math — the validity gate on the metric itself (no models).
Pins the false-positive cases the cross-model review flagged, plus the proxy's known blind spot.

    python3 test_score.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from score import match_concrete, match_abstract_tokens, pollution  # noqa: E402


# --- concrete: conservative, no short-generic or geographic false positives (review findings) ---
def test_concrete_single_token_exact_only():
    assert match_concrete("Virginia", ["Virginia"])
    assert not match_concrete("Virginia", ["West Virginia"])        # the geographic FP, fixed
    assert not match_concrete("Ohio", ["Ohio River"])              # single-token gold must be exact


def test_concrete_multitoken_containment():
    assert match_concrete("West Point", ["United States Military Academy at West Point"])
    assert match_concrete("Fort Sumter", ["the attack on Fort Sumter"])


def test_concrete_no_bare_generic_fp():
    assert not match_concrete("Fort Sumter", ["Fort"])             # a lone token must not credit a 2-word name
    assert not match_concrete("Union victory", ["Union Army"])     # one shared token is not enough


# --- abstract token FALLBACK (used only if the embedder is down); its blind spot is the whole point ---
def test_abstract_tokens_overlap_hits():
    assert match_abstract_tokens("abolition by violence", ["believed abolition required violence"])


def test_abstract_tokens_paraphrase_MISSED():
    # WHY abstract-R uses embeddings: token overlap cannot see a true paraphrase.
    assert not match_abstract_tokens("anti-imperialism", ["opposed American colonial expansion overseas"])


# --- pollution: ANY junk token flags it; empty is None (a parse failure is not "clean") ---
def test_pollution_any_junk_token():
    assert pollution(["Military Strategy"]) == 1.0                 # "Strategy" ∈ junk (was missed before)
    assert pollution(["Fort Sumter", "abolition of slavery"]) == 0.0
    assert abs(pollution(["Fort Sumter", "Leadership"]) - 0.5) < 1e-9


def test_pollution_empty_is_none():
    assert pollution([]) is None


def _run():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    p = 0
    for fn in fns:
        try:
            fn()
            print("  PASS", fn.__name__)
            p += 1
        except AssertionError as e:
            print("  FAIL", fn.__name__, e)
    print(f"\n{p}/{len(fns)} passed")
    return 0 if p == len(fns) else 1


if __name__ == "__main__":
    raise SystemExit(_run())
