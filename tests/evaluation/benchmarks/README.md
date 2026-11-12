# Third-Party Benchmark Evaluation Set

Status: not validated. This is development material for evaluating Analyst Skills; it does not certify a skill and its results are not real-world accuracy claims. It sits outside the runtime skill and is never copied into agent jobs.

The set turns three public datasets into blind Deep Proof dossiers. In each dataset, a GPT or Claude model wrote a summary or answer about a real document, and humans recorded what the output got wrong. A reviewer (an Analyst Skill run, or a person) receives the source document and the AI output, and is scored against the human labels.

| Dataset | Pinned source | Documents | AI outputs used | Human labels | License |
|---|---|---|---|---|---|
| FaithBench (NAACL 2025) | `vectara/FaithBench` @ `cf89797` | Short passages, 75 sources | GPT-4o, GPT-3.5-Turbo, Claude 3.5 Sonnet (2024) summaries | Character spans: Unwanted (intrinsic/extrinsic), Questionable, Benign | CC BY-NC-SA 4.0 |
| RAGTruth (ACL 2024) | `ParticleMedia/RAGTruth` @ `c103204` | News articles (CNN/Daily Mail, recent news) | gpt-4-0613, gpt-3.5-turbo-0613 summaries | Character spans: Evident/Subtle Conflict, Evident/Subtle Baseless Info | MIT; articles keep their original rights |
| FinanceBench (2023) | `patronus-ai/financebench` @ `cc39aeb` | SEC filings (PDF) | gpt-4-1106-preview, claude-2 answers, long-context (`inContext`) setting | Graded Correct Answer, Incorrect Answer or Refusal, with gold answer and evidence pages | No license file on GitHub; Hugging Face copy is CC BY-NC 4.0 |

Upstream data is never committed. FaithBench and FinanceBench carry non-commercial terms, while Deep Proof is GPL-3.0 with a commercial edition, so `build.mjs` downloads the pinned files into `.data/` (ignored by Git) for local evaluation only. Only the builder, the scorer, the comparison runner described under [Comparing Deep Proof With a Plain Agent](#comparing-deep-proof-with-a-plain-agent), `sources.json` (commits, sizes and hashes) and `selection.json` (case IDs) are in the repository.

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

A review that ran but produced no usable verdict (time limit, output that never validated) is recorded as `{"case-…": {"failed": true, "reason": "timeout"}}`. Precision, recall and the false-positive rate leave failed reviews out, as before. Three further figures count them: the share of failed reviews, recall with every failure on a problem case counted as a miss, and the share of clean controls passed with every failure counted as not passed. Read those when comparing reviewers, because a reviewer that fails on hard cases otherwise looks better than it is.

## Comparing Deep Proof With a Plain Agent

Status: built and tested offline, never run against a model. No comparison result exists yet.

Deep Proof runs a coding agent through ALA and adds a method to it: the verification skill, the registers, the validators and the repair loop. The question this part answers is whether that method finds more of the labelled problems, with fewer false alarms, than the same agent and model given the same dossier and a short instruction. `run.mjs` reviews every case with each chosen arm and keeps one record per arm, case and repeat. `compare.mjs` then compares two arms case by case.

| Arm | What reviews the dossier | Use |
|---|---|---|
| `always-problem`, `always-clear` | Nothing: a fixed answer | The floor any reviewer must beat |
| `plain` | The coding agent through ALA with `review-request.md` and `prompts/plain.md`, which only defines the output file | Does the method add anything |
| `plain-careful` | The same agent with `prompts/plain-careful.md`, a statement-by-statement method in one paragraph | Is the gain more than a better prompt |
| `deep-proof-check` | Check Report, deep verification, closed dossier, on a private Deep Proof instance | The product path |
| `deep-proof-triage` | Check Report at triage depth | The cheaper product setting |

Every arm in a campaign uses the agent, model and effort given on the command line, the same time limit, and the same dossier bytes. The review request reaches Check Report as its documented `scope` option and reaches the plain agent as the first part of its task, so both read the same task text. For a filing, the plain agent receives the PDF and the text Deep Proof itself extracts from it (`pdfText` in `arms.json`), so the comparison is about the review method and not about reading PDFs. The plain arms get no skills, no validators, no repair turns and no progress reminders. Arms are defined in `arms.json`; each has a fingerprint over its settings, its prompt text and, for Check Report, the hash of the verification skill, and records made under another fingerprint are never pooled.

```sh
cp -R tests/evaluation/benchmarks/.data/build/core/dossiers tests/evaluation/benchmarks/.data/build/core/cases.json /srv/benchmark/
node tests/evaluation/benchmarks/run.mjs --dossiers /srv/benchmark/dossiers --arena /srv/arena --out /srv/campaign-1 \
  --arms always-problem,always-clear,plain,plain-careful,deep-proof-check --agent codex --model gpt-6-luna \
  --partition final --repeats 3 --minutes 35 --agent-home /srv/agent-home
```

Without `--launch` this prints the plan and the upper bound on model usage, and runs nothing. Adding `--launch` starts the agent and consumes model usage: for the core final partition (86 cases), the three agent arms above and three repeats, that is 774 reviews of up to 35 minutes each. Run it only when a live run was explicitly requested, like `npm run test:llm`. The runner refuses to launch when `gold/` sits next to the dossiers, when the arena is inside or around this repository, or when a `gold` folder or any link lies under the arena, which is why the dossiers are copied first and the arena must be a new empty folder used by this campaign only; `--allow-visible-keys` overrides this and marks the campaign as exposed. It checks folder layout only and cannot observe what the agent sandbox mounts, so the best status it reports is `isolated_as_attested`.

Every review gets a private agent home. Without one, ALA mounts the saved state of the coding agent into its sandbox (for Codex, `~/.codex`), and Deep Proof gives ALA the whole home folder of the user who runs it for every analysis (`alaArguments` in `src/ala.mjs`). A review could then read what an earlier review left, and Check Report could read anything kept under that home folder, such as answer keys or the records of this campaign. `--agent-home` names a folder that holds only a login made for the campaign, for example after `CODEX_HOME=/srv/agent-home/.codex codex login`. For each review of either arm the runner copies it to a new folder under `agent-homes/` in the campaign folder, passes that folder to ALA as the home and removes it when the review ends. ALA binds that one folder into the sandbox, never its parent. Nothing is copied back, so a login file that the agent's client rewrites does not reach the next review; the record of the review names such files. If that was a real token refresh, later reviews may fail to sign in, which shows as suspect failures and stops the run: a fresh login made just before the campaign, or an API key in the environment, avoids this. While reviews run, the `HOME` of the runner process is the private home, and between reviews an empty folder, never the user's own home, because Deep Proof takes the home it passes to ALA from its own process. A check that the runner gives up on, after an unreadable status, an overrun or an exception, would keep running inside the instance and start its next turn with whatever home came next. The runner therefore stops its engine until no check is left running, and waits until no sandbox uses the home, before the home is removed and the next review starts. If that fails, the review keeps its outcome and the run stops. Deep Proof also runs `python3` on the host to replay numeric checks; the runner sets `PYTHONNOUSERSITE` for every campaign, so start-up code an agent writes into a home is not loaded there. With a private home, ALA finds the coding agent only on `PATH` or through the agent's own location variable (for Codex, `CODEX_BIN`), and the runner checks this before it starts. The login folder must lie outside the arena, the output folder and the dossier folder. `--shared-agent-state` launches without a private home; the campaign is then marked for good, and `compare.mjs` calls every comparison of it that involves a reviewing arm exploratory. Two things stay visible to the agent with a private home as well: the system folders, and the install locations of the coding agent's program and of Node.js, which ALA mounts read-only wherever they are (for an agent installed through npm, the whole npm prefix).

A campaign folder freezes the agent, model, effort, time limit, repeats, seed, the case list, the bytes of every dossier, a hash of the application and runner code (`server.mjs`, `package.json`, `src/`, `skills/`, the two `web/` files the engine path loads, and the runner files) and the ALA installation; a later command that differs in any of them is refused. Run a campaign from a checkout that nobody edits until it has finished. The model must be named, so the campaign records which model reviewed the cases; the version of the coding agent's own program is not recorded. `DEEP_PROOF_WORK_MS` and `DEEP_PROOF_WRAPUP_MS` are refused, because they would shorten Check Report's time limit only. Units run in a seeded shuffled order, so arms interleave and a change in the model service during the campaign affects them alike. Run the arms to be compared in one command: `compare.mjs` warns when two arms did not run over the same period.

Each unit ends in one of three states. `completed` has a verdict. `failed` is the reviewer's own failure and is scored as a wrong answer. `error` is never scored. The state comes only from signals the runner controls: whether the engine could be found and started, whether it stopped at the time limit, its exit status, HTTP status codes and the files it left. Error text never decides it, because that text can quote the documents and the reviewer's own prose; `analysisFailure` in `src/analysis-failure.mjs`, which reads such text, is not used for scoring. The table gives the rule for both arms.

| What happened | Plain agent | Check Report | State |
|---|---|---|---|
| A verdict exists, also one written or validated just before the time limit | `prediction.json` is valid | A validated check, complete or incomplete | `completed` |
| Time ran out without one | Stopped at the limit, no valid file | Notes only, or still running ten minutes past the limit | `failed` (`timeout`) |
| The output is unusable | No valid `prediction.json` | Three validation attempts failed | `failed` (`invalid_output`, `validation`) |
| The engine ran and ended badly | Non-zero exit | Deep Proof reports another failure | `failed`, marked suspect |
| Deep Proof declines the document | The agent still gets the PDF | Upload refused (bad file, no text, too much text) | `failed` (`ingestion`) for Check Report |
| No review could start | ALA missing, engine or converter not started | The same, a refused start or a session problem | `error`, not an attempt |
| The runner or server broke during a review | An exception | An exception, or the server stopped answering | `error`, an attempt |

A suspect failure may be an infrastructure problem, such as an exhausted quota, but the runner cannot tell, so it stays scored as a wrong answer. When one arm ends three runs in a row in an error or a suspect failure, the run stops so that someone can look. A unit whose review ended in an error three times is not started again. From there only a recorded decision changes a unit: `run.mjs resolve --out /srv/campaign-1 --unit UNIT --as rerun --reason "…"` clears a failed or stopped unit to run again, and `--as failed` settles a stopped unit as a wrong answer. A completed review is never discarded. Decisions are kept in `campaign.json` and every comparison shows their count for each arm. Because only a review that did not complete can be cleared, a rerun can only help its arm. `compare.mjs` therefore gives a second, strict reading whenever a review was run a second time, in which each review that an operator cleared, or that was cut short and then run again, counts as failed whatever the later run gave. It calls the result exploratory when the two readings disagree.

A unit is marked as started before its engine runs. If the runner is interrupted or dies during a review, the next command finds that mark and records the review as an attempt lost to an error before it runs the unit again. A run cut short is therefore counted, is run again only within the limit of three, and counts as failed in the strict reading. `attempts.jsonl` in the campaign folder keeps every state a unit ever had, including these. One runner works on a campaign folder at a time, and `resolve` is refused while one is running. The lock that enforces this names its holder by process id, start time and process namespace, and the holder refreshes it every 15 seconds. On the same machine and in the same container, the lock of a runner that was killed stops counting at once. A runner in another container or on another host cannot be looked up, so its lock counts while it is being refreshed; after such a runner was killed outright, the next one is refused for up to 90 seconds. A runner that finds its lock taken over starts no further review. Two setups are not covered: runners of different users on a system that hides other users' processes, and code edited while a runner is working. Use one user and an unchanged checkout for a campaign.

Interrupting the runner stops the engines it started, including the engine of a check that is running inside the private Deep Proof instance; this needs `ps -A -o pid=,ppid=` to work on the host, and a campaign does not start without it. A runner that is killed outright cannot stop its engine: look for a leftover engine process before starting again. In a container, start the runner under an init process (`--init` with Podman or Docker), so that stopped engines are collected. The runner signs in to the private instance again when its eight-hour session ends.

A finished work folder of the plain agent is moved from the arena to `work/` in the campaign folder, and a folder left by a runner that died is moved before the next review starts, so no review can read another one's folder. If a folder cannot be moved, the review keeps its outcome and the run stops. An arena belongs to one campaign: the runner refuses an arena that holds work folders of another run. It can detect this only while such folders are present, so never give two campaigns the same arena.

Check Report does not answer `problem` or `no_problem`, so its findings register is mapped by a fixed rule: the case is flagged when the check confirmed (or narrowed) at least one finding about the report under review in category F01 contradicted fact, F02 insufficient support, F03 invalid inference or F06 numerical error. Omissions (F04) and the other categories do not flag a case, because the answer keys label unsupported content only. The flagged quotations are the findings' exact target passages. The rule is part of the arm and of its fingerprint. Because it is a judgment, every record keeps the confirmed findings, and `run.mjs collect --out /srv/campaign-1 --predictions /srv/campaign-1/predictions-any --flag-categories all` rewrites the prediction files under another rule without running anything again.

```sh
node tests/evaluation/benchmarks/score.mjs --predictions /srv/campaign-1/predictions/plain.r1.json
node tests/evaluation/benchmarks/compare.mjs --predictions /srv/campaign-1/predictions \
  --baseline plain --candidate deep-proof-check --partition final --output comparison.json
```

Answer keys are read by `score.mjs` and `compare.mjs` only, so the campaign itself can run on a machine that has no keys. `compare.mjs` reports, for both arms, the share of problem cases flagged, the share of clean cases passed and their mean (balanced accuracy), with failed reviews counted as wrong answers, and the difference between the arms with a 95% interval. The interval comes from resampling document families, because outputs about one source document are not independent. With repeats, a case contributes the share of its repeats that were right. An exact McNemar test on cases that were right in every repeat is reported beside it. Ambiguous and refusal cases are left out, as in `score.mjs`. Beside the measures it prints, for each arm, the failed reviews, the errors before a review started, the attempts lost to an error, the operator decisions and the run time. The command refuses a campaign with unfinished units unless `--allow-incomplete` is given. It labels the result an exploratory reading, not a campaign result, when the answer keys were exposed, when reviews did not each get a private agent home, when cases were left out as incomplete, when the comparison is not restricted to the final partition, when a recomputed category rule is in use, when one arm is a constant answer or when the strict reading disagrees with the main one. It also warns when there are fewer than three repeats, when the arms did not run over the same period, when an operator decision changed a unit and when failed reviews are marked suspect.

Decide before the campaign which difference decides it (the suggested one is balanced accuracy on the final partition, candidate against `plain-careful`), tune the plain prompts on the development partition only, and report the result whichever way it falls. The core final partition holds 38 problem and 39 clean cases from 31 document families. A simulation of the paired test, with flagging rates rising from 70% to 85% of problem cases, detects that difference in roughly a quarter to a third of such campaigns; about 125 to 150 problem cases give four chances in five, which needs the full profile. A campaign on the core profile can therefore show a large difference and cannot rule out a moderate one.

Tests of the runner and the comparison are in `tests/benchmark-runner.test.mjs`. They use hand-authored dossiers, reviewer outputs, registers and answer keys, inject a stand-in for the engine launch, and start a private Deep Proof instance with ALA pointed at a missing path to confirm that a check is prepared and then refused. They call no model. A pilot of two development cases on 11 November 2026, with Codex, `gpt-6-luna` and 35 minutes, exercised the plain-agent launch line against a real ALA installation and ALA's acceptance of the agent and model: both plain reviews completed. Both Check Report reviews reached the time limit while writing their records, so a check that runs to completion through the runner has still not been observed. That pilot ran before reviews had private agent homes. Start with a pilot of a few development cases, and a time limit that Check Report can meet, before a campaign.

## Limits

FaithBench passages were chosen because hallucination detectors disagreed on them, so its rates describe a hard subset, not typical model behaviour. All AI outputs date from 2023–2024: no public dataset with human labels on GPT-5 or Claude 4 outputs was found. Labels are the datasets' own, unreviewed here; annotators disagree, and FaithBench keeps each annotation. Summarization cases test unsupported content rather than omissions, which only FinanceBench refusals touch. TofuEval was not used because its release anonymizes which model wrote each summary.

The comparison measures review of an existing AI output, not the quality of a report Deep Proof writes itself, and it scores the verdict and the flagged passages, not whether a quoted source passage actually supports a finding. A difference found here holds for the agent, model, time limit and document types of that campaign, and has to be measured again after any of them changes.

Three properties of the set bear on both arms alike. Every review request names the source dataset, so a reviewer can tell that the case comes from a hallucination benchmark and may flag more readily than on ordinary work. A document that Deep Proof declines fails the case for Check Report while the plain agent still receives the PDF, so the two arms are not judged on the same footing for such a document; the count appears as `ingestion` among the failure reasons. Check Report findings are counted only at level `target`; if a check filed a defect of the AI output under another level, the case would not be flagged, and the kept findings show the level of each.
