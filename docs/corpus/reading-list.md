---
source: reading-list.md.docx
author: Brian Brewington
original_date: 2026-07-11
captured: 2026-07-12
origin: Google Drive export (drive-download-20260712T124422Z-2-001)
note: Curated short reading list — attention, review, and the threshold. Deliberately small; each entry earns its slot.
---

Short Reading List — Attention, Review, and the Threshold

*Curated small on purpose; each entry earns its slot. Yes, a reading list is itself attention shaping — someone else's router deciding what crosses your threshold. Caveat lector.*

The formal core

- **Herbert Simon, "Designing Organizations for an Information-Rich World" (1971).** The origin of the sentence everyone quotes: a wealth of information creates a poverty of attention, and the design problem is allocating attention efficiently. Twelve pages; the whole book's thesis is arguably a footnote to it. Read first.



- **Maćkowiak, Matějka & Wiederholt, "Rational Inattention: A Review" (J. Econ. Literature, 2023).** The mature survey of Sims's program: agents with an information-capacity constraint choose *what to attend to*, and the optimum ignores below a threshold. Your thesis's shadow-price cliff, in economists' notation, with applications to disclosure regulation (where obfuscation defeats format rules — the boilerplate/omnibus failure, formalized). Skim §§ on discrete choice and disclosure.



- **B.O. Koopman, "Search and Screening" (OR classic; the 1946 report or the 1980 book).** WWII-era optimal search: effort density allocated by target-probability, with regions below a threshold receiving *zero* effort. The oldest rigorous version of the hard line. Read for the pleasure of recognition.

The failure canon

- **Diane Vaughan, "The Challenger Launch Decision" (1996).** Normalization of deviance as an *administrative reclassification* process — live anomaly signals re-binned as "in-family" under schedule pressure, i.e., moved below the attention line by paperwork. The deepest single case study of a captured router. Long; the analytical chapters (esp. on the eve-of- launch teleconference) carry it.



- **Charles Perrow, "Normal Accidents" (1984).** Coupling × complexity as the structural cause of system failure. Deliberately *not* an attention theory — read it to locate the boundary of your claim: what Perrow explains that the channel model doesn't, and vice versa. A book you argue with in the margins.



- **Atul Gawande, "The Checklist Manifesto" (2009).** You've read it; re-read the aviation chapters through the new lens: a checklist is a hand-compiled attention router, and its power comes from *removing* items from the lit region as much as adding them.

The domain you'll measure

- **Sadowski et al., "Modern Code Review: A Case Study at Google" (ICSE-SEIP 2018).** The empirical anatomy of the send-it-back culture: median reviews are small, fast, and single-reviewer, and the paper documents the institution's deliberate pressure toward small CLs — channel-sizing as policy. Your baseline citation for "review effort saturates."



- **Śliwerski, Zimmermann & Zeller, "When Do Changes Induce Fixes?" (MSR 2005).** The SZZ paper: tracing fixes back to bug-inducing commits. The methodological ancestor of the escape-mining study; read for the known failure modes of the tracing (which reviewers of your paper will probe).

The inversion (channel-side design)

- **Christopher Wickens et al., "Engineering Psychology and Human Performance" (any recent edition) — the attention & display-design chapters.** The seventy-year-old discipline of arranging the world to fit a fixed channel: salience, expectancy, effort, value (the SEEV model is literally importance × change-rate for visual scanning). The vocabulary your presentation experiments will be reviewed in.

One deliberately unquiet pick

- **The Underhanded C Contest archives (underhanded-c.org).** Adversarial review-shaping as a competitive art form: code engineered so the payload sits below any plausible reviewer's line. Read three winners and you'll never trust a diff the same way. The XZ backdoor (2024) postmortems are the non-fiction sequel.



*Noted but cut for length: Ocasio's attention-based view of the firm (1997) if the org-theory chapter grows; Bazerman & Watkins "Predictable Surprises"; Tufte on display density; Sims 2003 if you want the information-theoretic original rather than the review.*
