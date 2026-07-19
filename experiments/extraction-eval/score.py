#!/usr/bin/env python3
"""Score extractions against the hand-labeled gold (gold/manifest.jsonl).

Per model: concrete-recall, abstract-recall, pollution, parse-error rate, latency.

MATCHING (hardened after cross-model review):
- CONCRETE: conservative word-level match. A single-token gold entity ("Virginia") requires an exact
  token match — so it will NOT credit "West Virginia". Multi-token gold matches if fully contained in
  an extraction, or ≥2 shared tokens. No bare-substring matches for short/generic items.
- ABSTRACT: EMBEDDING match (Ollama embeddinggemma), cosine ≥ --thresh. Token overlap cannot license a
  *comparative* abstract claim (a shared paraphrase floor can hide or flip the tiny-vs-large gap), so
  abstract-R is embedding-based. If the embedder is unreachable, it falls back to token overlap and
  prints a loud warning that abstract DELTAS are NOT identified.

    python3 score.py [--thresh 0.60] [results/*.jsonl ...]
"""
import glob
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
STOP = set("the a an of to in and or for with on at by from as is was were are be his her their its "
           "this that into over under most first".split())
JUNK = set("strategy innovation leadership synergy vision excellence growth impact success change "
           "life time history future freedom liberty war politics work society people world nation".split())
EMBED_URL = "http://127.0.0.1:11434/api/embeddings"
EMBED_MODEL = "embeddinggemma"
_ecache = {}


def toks(s):
    return [w for w in re.sub(r"[^a-z0-9 ]", " ", s.lower()).split() if w not in STOP and len(w) > 2]


def match_concrete(gold_item, extracted):
    """Conservative: exact single tokens, containment or ≥2 shared tokens for multi-token names."""
    g = toks(gold_item)
    if not g:
        return False
    gset = set(g)
    for e in extracted:
        et = set(toks(e))
        if not et:
            continue
        if len(gset) == 1:
            if et == gset:                       # exact ("Virginia" != "West Virginia")
                return True
        else:
            if gset <= et:                        # gold fully contained ("West Point" in "USMA at West Point")
                return True
            if et <= gset and len(et) >= 2:        # extraction is a shorter multi-token form of gold
                return True
            if len(gset & et) >= 2 and len(gset & et) / len(gset) >= 0.6:
                return True
    return False


def embed(text):
    if text in _ecache:
        return _ecache[text]
    body = json.dumps({"model": EMBED_MODEL, "prompt": text}).encode()
    req = urllib.request.Request(EMBED_URL, data=body, headers={"Content-Type": "application/json"})
    v = json.loads(urllib.request.urlopen(req, timeout=60).read())["embedding"]
    n = sum(x * x for x in v) ** 0.5 or 1.0
    v = [x / n for x in v]
    _ecache[text] = v
    return v


def match_abstract_embed(gold_item, extracted, thresh):
    if not extracted:
        return False
    gv = embed(gold_item)
    for e in extracted:
        ev = embed(e)
        if sum(a * b for a, b in zip(gv, ev)) >= thresh:
            return True
    return False


def match_abstract_tokens(gold_item, extracted):
    g = set(toks(gold_item))
    for e in extracted:
        et = set(toks(e))
        if et and len(g & et) >= 2 and len(g & et) / min(len(g), len(et)) >= 0.5:
            return True
        if gold_item.lower() in e.lower():
            return True
    return False


def pollution(items):
    """Fraction of extractions containing ANY forbidden junk token. None if the list is empty."""
    if not items:
        return None
    bad = sum(1 for e in items if set(toks(e)) & JUNK)
    return bad / len(items)


def main():
    args = sys.argv[1:]
    thresh = 0.60
    if "--thresh" in args:
        i = args.index("--thresh")
        thresh = float(args[i + 1])
        del args[i:i + 2]
    gold = {}
    for ln in open(os.path.join(HERE, "gold", "manifest.jsonl")):
        if ln.strip():
            g = json.loads(ln)
            gold[g["id"]] = g
    files = args or sorted(glob.glob(os.path.join(HERE, "results", "*.jsonl")))
    if not files:
        sys.exit("no results/*.jsonl — run run.py first")

    # embedder availability decides the abstract metric (and the honesty of the comparison)
    embed_ok = True
    try:
        embed("probe")
    except Exception as e:  # noqa: BLE001
        embed_ok = False
        print(f"!! embeddinggemma unreachable ({e}); abstract-R falls back to TOKEN proxy — "
              f"abstract DELTAS are NOT identified (do not compare models on abstract).\n")

    print(f"{'model':<16}{'concrete-R':>11}{'abstract-R':>11}{'pollution':>11}{'parse-err':>10}{'lat(s)':>8}   n")
    print("-" * 78)
    for fp in files:
        rows = []
        for i, ln in enumerate(open(fp)):
            if ln.strip():
                try:
                    rows.append(json.loads(ln))
                except Exception:  # noqa: BLE001
                    print(f"  (bad JSONL line {i} in {fp}, skipped)")
        cr, ar, pol, lat, perr = [], [], [], [], 0
        for r in rows:
            g = gold.get(r["id"])
            if not g:
                print(f"  (unknown id {r.get('id')} in {os.path.basename(fp)})")
                continue
            ex = r.get("extracted", {}) or {}
            if ex.get("_parse_error") or ex.get("_error"):
                perr += 1
            gc, ga = g["gold"]["concrete"], g["gold"]["abstract"]
            xc, xa = ex.get("concrete", []) or [], ex.get("abstract", []) or []
            cr.append(sum(match_concrete(x, xc) for x in gc) / len(gc) if gc else 0)
            am = (lambda x, l: match_abstract_embed(x, l, thresh)) if embed_ok else match_abstract_tokens
            ar.append(sum(am(x, xa) for x in ga) / len(ga) if ga else 0)
            p = pollution(xc + xa)
            if p is not None:
                pol.append(p)
            lat.append(r.get("latency", 0))
        n = len(cr)
        if n != len(gold):
            print(f"  (WARNING: scored {n}/{len(gold)} gold figures for {os.path.basename(fp)})")
        mean = lambda a: sum(a) / len(a) if a else 0
        lab = rows[0]["label"] if rows else os.path.basename(fp)
        tag = "" if embed_ok else " (tok)"
        print(f"{lab:<16}{mean(cr):>11.0%}{mean(ar):>10.0%}{tag:<1}{('' if pol else 'n/a'):>0}"
              f"{mean(pol):>11.0%}{perr:>6}/{n:<3}{mean(lat):>8.1f}   {n}")
    if embed_ok:
        print(f"\nabstract-R = embedding match (embeddinggemma, cosine ≥ {thresh}). Still a proxy for human "
              f"judgment; calibrate --thresh and spot-check disagreements before a headline claim.")


if __name__ == "__main__":
    main()
