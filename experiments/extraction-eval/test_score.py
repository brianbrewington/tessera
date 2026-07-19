#!/usr/bin/env python3
"""Deterministic tests for the scoring math — the validity gate on the metric itself (no models).

    python3 test_score.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from score import matched, pollution  # noqa: E402


def test_matched_exact():
    assert matched("Fort Sumter", ["Fort Sumter", "West Point"])
    assert not matched("Fort Sumter", ["Gettysburg", "Appomattox"])


def test_matched_substring_either_direction():
    assert matched("West Point", ["United States Military Academy at West Point"])
    assert matched("Adventures of Huckleberry Finn", ["Huckleberry Finn"])


def test_matched_token_overlap_for_paraphrasable_abstract():
    assert matched("abolition by violence", ["believed abolition required violence"])
    assert not matched("free verse", ["states' rights and secession"])


def test_matched_semantic_paraphrase_is_MISSED_by_proxy():
    # THE honest caveat, pinned: token overlap cannot catch a true paraphrase with no shared tokens.
    # This is *why* abstract-recall is reported as a lower bound.
    assert not matched("anti-imperialism", ["opposed American colonial expansion overseas"])


def test_pollution():
    assert pollution(["Strategy", "Innovation"]) == 1.0            # pure junk
    assert pollution(["Fort Sumter", "abolition of slavery"]) == 0.0
    assert abs(pollution(["Fort Sumter", "Leadership"]) - 0.5) < 1e-9
    assert pollution([]) == 0.0                                    # empty extraction → no pollution


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
