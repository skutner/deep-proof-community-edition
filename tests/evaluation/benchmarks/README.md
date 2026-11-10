# Third-Party Benchmark Evaluation Set

Status: not validated. This is development material for evaluating Analyst Skills; it does not certify a skill and its results are not real-world accuracy claims. It sits outside the runtime skill and is never copied into agent jobs.

The set turns three public datasets into blind Deep Proof dossiers. In each dataset, a GPT or Claude model wrote a summary or answer about a real document, and humans recorded what the output got wrong. A reviewer (an Analyst Skill run, or a person) receives the source document and the AI output, and is scored against the human labels.

| Dataset | Pinned source | Documents | AI outputs used | Human labels | License |
|---|---|---|---|---|---|
| FaithBench (NAACL 2025) | `vectara/FaithBench` @ `cf89797` | Short passages, 75 sources | GPT-4o, GPT-3.5-Turbo, Claude 3.5 Sonnet (2024) summaries | Character spans: Unwanted (intrinsic/extrinsic), Questionable, Benign | CC BY-NC-SA 4.0 |
| RAGTruth (ACL 2024) | `ParticleMedia/RAGTruth` @ `c103204` | News articles (CNN/Daily Mail, recent news) | gpt-4-0613, gpt-3.5-turbo-0613 summaries | Character spans: Evident/Subtle Conflict, Evident/Subtle Baseless Info | MIT; articles keep their original rights |
| FinanceBench (2023) | `patronus-ai/financebench` @ `cc39aeb` | SEC filings (PDF) | gpt-4-1106-preview, claude-2 answers, long-context (`inContext`) setting | Graded Correct Answer, Incorrect Answer or Refusal, with gold answer and evidence pages | No license file on GitHub; Hugging Face copy is CC BY-NC 4.0 |

Upstream data is never committed. FaithBench and FinanceBench carry non-commercial terms, while Deep Proof is GPL-3.0 with a commercial edition, so `build.mjs` downloads the pinned files into `.data/` (ignored by Git) for local evaluation only. Only the builder, scorer, `sources.json` (commits, sizes and hashes) and `selection.json` (case IDs) are in the repository.

## Build

```sh
node tests/evaluation/benchmarks/build.mjs
```

The core profile downloads about 41 MB of dataset files and 15 filing PDFs (24 MB), verifies every file against `sources.json` (sha256; Git blob SHA-1 for PDFs) and writes 120 cases to `.data/build/core/`. `--offline` rebuilds from the cache. The full profile (`--profile full`) has 2,411 cases and needs 69 more filing PDFs (141 MB); it stops and states the size unless `--allow-large-download` is given. The core build fails if the computed selection differs from the committed `selection.json`; `--write-selection` regenerates it after a deliberate change. Nothing calls a model.

## Layout and blinding

| Path | Contents | Give to the reviewer |
|---|---|---|
| `dossiers/<case>/review-request.md` | The task, the dataset and pinned commit | Yes |
| `dossiers/<case>/source.txt`, `ai-summary.txt` | Summarization cases: the source and the AI summary, byte-exact | Yes |
| `dossiers/<case>/<filing>.pdf`, `ai-answer.txt` | FinanceBench cases: the filing, the question and the AI answer | Yes |
| `gold/<case>.json` | Answer key: model, expected verdict, labelled spans with annotator notes, FinanceBench gold answer and evidence, upstream record ID | Never |
| `cases.json` | Blind case list with dataset and partition | Optional |

Dossiers never name the model, the label or the upstream record; the build fails if any review request names a model or a label term. Case IDs are hashes of public inputs, and `gold/`, `selection.json` and this code can map a case back to its upstream record, so give the reviewing agent only the dossier folder, never this repository or the build root. The source and AI-output files are upstream text reproduced exactly, so an agent with web access could still find a case upstream; run reviews without network access where possible.

## Answer keys

| Dataset | `problem` | `no_problem` | Kept apart |
|---|---|---|---|
| FaithBench | Any annotator marked an Unwanted span | No annotations | `ambiguous`: worst label Questionable or Benign, kept as recorded and excluded from precision and recall |
| RAGTruth | Any labelled span | No labels | `refusal` for the upstream `incorrect_refusal` quality (none among the selected GPT summaries); a `truncated` response stops the build |
| FinanceBench | Incorrect Answer | Correct Answer | `refusal`, scored separately so refusals (59 of GPT-4-Turbo's 150 answers) do not distort precision and recall |

The mapping is written here rather than taken from FaithBench's `scripts/binarize.py`, which returns 0 both for unannotated samples and for its hallucinated class. Unknown label strings stop the build; the FaithBench README spells one label "Instrinsic", while the data uses the schema's "Intrinsic". Every span is checked against its recorded text before a case is written. Answer keys keep every annotation, but only spans the reviewer is expected to find carry `target: true`: FaithBench spans with an Unwanted label and all RAGTruth spans. Benign or Questionable spans inside a problem case stay in the key with `target: false`.

FinanceBench grades compare the answer with a gold answer, so a Correct Answer can still contain unsupported reasoning. Upstream `evidence_page_num` counts from 0 (page index 59 of `3M_2018_10K.pdf` holds the cash-flow statement it cites); answer keys store both `pageIndex` and the 1-based `pdfPage` that Deep Proof shows as `## Page N`. When Poppler is installed, the build also records whether each filing is within Deep Proof's 2,000,000-character limit and whether each evidence passage is found in the extracted text. Without `pdftotext` the answer key says these checks were not run.

## Core profile

Selection works on document families: a FaithBench source passage, a RAGTruth article or a FinanceBench company. A chosen family contributes every GPT and Claude output about it, so each source has paired outputs from several models, and the whole family falls in one partition (development, calibration or final, by hash) as `tests/evaluation/report-quality/README.md` requires. RAGTruth draws 12 families with at least one labelled summary and 8 clean families; FinanceBench takes up to two questions from each of 8 companies.

| Dataset | Cases | problem | no_problem | ambiguous | refusal | Partitions (dev / calibration / final) |
|---|---|---|---|---|---|---|
| FaithBench | 48 (16 per model) | 29 | 12 | 7 | 0 | 3 / 15 / 30 |
| RAGTruth | 40 (20 per model) | 13 | 27 | 0 | 0 | 6 / 6 / 28 |
| FinanceBench | 32 (16 per model) | 14 | 13 | 0 | 5 | 4 / 0 / 28 |

The problem cases hold 41 FaithBench and 13 RAGTruth labelled issues (overlapping target spans merged). With so few families, partitions are uneven, and FinanceBench has no calibration case in the core profile.

## Scoring

Record one verdict per reviewed case, with the exact AI-output text the review flagged (for FinanceBench, text from the AI answer, not the question):

```json
{"case-0123456789ab": {"verdict": "problem", "quotes": ["exact sentence from ai-summary.txt"]},
 "case-ba9876543210": {"verdict": "no_problem"}}
```

```sh
node tests/evaluation/benchmarks/score.mjs --predictions predictions.json --output result.json
```

The scorer reports, overall and by dataset, model and partition: precision, recall, false positives on clean controls, the share of refusals and ambiguous cases flagged, labelled issues hit by a flagged quote and quotes not found in the AI output. Each rate carries its counts and a Wilson 95% interval. A labelled issue is a region of overlapping target spans, so near-duplicate spans from several annotators count once; it is hit when any occurrence of a flagged quote overlaps it, and its denominator includes problem cases the review missed. Quotes are matched with the whitespace normalization used by `validateMarkdownReport`, and quotes not found in the AI output are counted for every prediction. Missing predictions are counted, not treated as negatives. Deterministic tests of this code are in `tests/benchmark-evaluation.test.mjs` and use hand-authored records only.

## Limits

FaithBench passages were chosen because hallucination detectors disagreed on them, so its rates describe a hard subset, not typical model behaviour. All AI outputs date from 2023–2024: no public dataset with human labels on GPT-5 or Claude 4 outputs was found. Labels are the datasets' own, unreviewed here; annotators disagree, and FaithBench keeps each annotation. Summarization cases test unsupported content rather than omissions, which only FinanceBench refusals touch. TofuEval was not used because its release anonymizes which model wrote each summary.
