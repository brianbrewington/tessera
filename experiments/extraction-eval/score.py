#!/usr/bin/env python3
"""Score extractions against the hand-labeled gold (gold/manifest.jsonl).

Metrics per model: concrete-recall, abstract-recall (fraction of the SALIENT gold entities the
model surfaced), and pollution (fraction of extracted items that are forbidden junk).

*** HONEST CAVEAT (the habituation discipline) ***
The match here is a TOKEN-OVERLAP PROXY. It is robust for CONCRETE entities (named, low-paraphrase)
but UNDER-COUNTS ABSTRACT recall, because a model can express a gold idea in words that don't share
tokens ("anti-imperialism" vs "opposed American colonial expansion"). So abstract-recall reported
here is a LOWER BOUND; a real number needs embedding-match (v2) or blind two-rater human
adjudication. test_score.py pins this limitation as an explicit test.

Usage: python3 score.py [results/*.jsonl ...]   (default: all results/*.jsonl)
"""
import glob
import json
import os
import re
import sys

STOP = set("the a an of to in and or for with on at by from as is was were are be his her their "
           "its this that his an into over under most first".split())
# forbidden buzzwords / existentials / empty-shells (the NEGATIVE_CONSTRAINTS list, single-word form)
JUNK = set("strategy innovation leadership synergy vision excellence growth impact success change "
           "life time history future freedom liberty war politics work society people world nation".split())


def toks(s):
    return [w for w in re.sub(r"[^a-z0-9 ]", " ", s.lower()).split() if w not in STOP and len(w) > 2]


def matched(gold_item, extracted_list):
    """Proxy match: substring either direction, or ≥50% token overlap over the smaller token set."""
    g = set(toks(gold_item))
    if not g:
        return False
    gl = gold_item.lower()
    for e in extracted_list:
        el = e.lower()
        if gl in el or el in gl:
            return True
        et = set(toks(e))
        if et and len(g & et) / min(len(g), len(et)) >= 0.5:
            return True
    return False


def pollution(items):
    if not items:
        return 0.0
    bad = 0
    for e in items:
        t = toks(e)
        if t and set(t) <= JUNK:            # every meaningful token is a forbidden junk word
            bad += 1
    return bad / len(items)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    gold = {g["id"]: g for g in (json.loads(l) for l in
            open(os.path.join(here, "gold", "manifest.jsonl")) if l.strip())}
    files = sys.argv[1:] or sorted(glob.glob(os.path.join(here, "results", "*.jsonl")))
    if not files:
        sys.exit("no results/*.jsonl — run run.py first")

    print(f"{'model':<16}{'concrete-R':>11}{'abstract-R*':>12}{'pollution':>11}{'lat(s)':>9}   n")
    print("-" * 70)
    for fp in files:
        rows = [json.loads(l) for l in open(fp) if l.strip()]
        cr, ar, pol, lat = [], [], [], []
        for r in rows:
            g = gold.get(r["id"])
            if not g:
                continue
            ex = r.get("extracted", {}) or {}
            gc, ga = g["gold"]["concrete"], g["gold"]["abstract"]
            xc, xa = ex.get("concrete", []) or [], ex.get("abstract", []) or []
            cr.append(sum(matched(x, xc) for x in gc) / len(gc) if gc else 0)
            ar.append(sum(matched(x, xa) for x in ga) / len(ga) if ga else 0)
            pol.append(pollution(xc + xa))
            lat.append(r.get("latency", 0))
        n = len(cr)
        mean = lambda a: sum(a) / len(a) if a else 0
        lab = rows[0]["label"] if rows else os.path.basename(fp)
        print(f"{lab:<16}{mean(cr):>11.0%}{mean(ar):>12.0%}{mean(pol):>11.0%}{mean(lat):>9.1f}   {n}")
    print("\n* abstract-R is a LOWER BOUND (token-overlap proxy under-counts paraphrase) — see module docstring.")


if __name__ == "__main__":
    main()
