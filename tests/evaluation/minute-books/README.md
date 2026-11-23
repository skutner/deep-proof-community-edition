# Minute Books: Edition 8 Recipe

Status: not validated. This is development material for evaluating document reviewers; it does not certify an Analyst Skill and its results are not real-world accuracy claims. It sits outside the runtime skill and is never copied into agent jobs.

This folder rebuilds the six generated minute books behind the comparison published at [deepproof.ch/two-agents-six-minute-books.html](https://deepproof.ch/two-agents-six-minute-books.html), with their answer keys, byte for byte. Nothing of the books or keys is committed: `selection.json` pins the generator, the seed and the SHA-256 of every book file and key, and `build.mjs` regenerates them into `.data/` (ignored by Git) and refuses a build in which any of them differs.

## What the Books Are

Each dossier is a committee minute book of four or five long volumes (`sources/minute-book-N.md`), a short `sources/procedure.md`, and two reports to check against them: `report-correct.md`, whose statements are all supported, and `report-mixed.md`, which also holds statements the minutes refute. A report has 24 statements about awards, counts and sums, each with a verdict and an exact value to give. The family is edition 8 of the `minutes` family of the [`lean_documents`](https://github.com/skutner/lean_documents) generator: the world and size of edition 6, with some returned payments told in quiet words. The answer key of each dossier holds every generated fact, so a statement is scored by recomputing it, not by reading free text.

| Item | Value |
| --- | --- |
| Generator | `skutner/lean_documents` at `e36c1d7b16dc39d073a399eef7806c14e0b228c8`: `evalsuite/generate_big.py`, `evalsuite/generate.py`, `evalsuite/big_minutes.py` |
| Command | `BIG_MINUTES_EDITION=8 python3 -I -B evalsuite/generate_big.py --fixtures NEW_DIR --keys NEW_DIR --seed 82829258 --dossiers 6 --families minutes` |
| Dossiers | `g82829258-001-minutes` to `g82829258-006-minutes`, about 2.9 MB of fixtures and 4.2 MB of answer keys |

## Recorded Results

Each model reviewed every report twice, each time in a fresh session: 24 reviews and 576 answers per model. An answer is right only when both its verdict and its value match the key. Four reviews share each book, so they are not independent samples of document reading.

| Model, effort | Answers not right | Reviews with at least one | Source |
| --- | --- | --- | --- |
| gpt-6-astra, xhigh | 169 of 576 | 12 of 24 | [replication guide](https://deepproof.ch/testing-data/astra-comparison/guide.txt), per-review rows in [reviews.csv](https://deepproof.ch/testing-data/astra-comparison/reviews.csv) |
| gpt-6.2-astra, xhigh | 0 of 576 | 0 of 24 | the same guide and rows |
| gpt-6.2-sol, xhigh | 89 of 576 | 6 of 24 | the [article](https://deepproof.ch/two-agents-six-minute-books.html) only; its three stages were read separately, with no test fixed in advance for their sum |

The two astra runs went through AdvancedLanguageAgent at `cae1563` with the Codex CLI (0.168.0 for gpt-6-astra, 0.170.0 for gpt-6.2-astra), the plain arm of `evalsuite/arms-shown-sums.json`, a fresh working folder and private home per review and a one-hour limit, as the guide states. All recorded reviews were launched by a private study harness that is not part of this repository.

## Build

```sh
node tests/evaluation/minute-books/build.mjs
```

The build downloads the three generator files from GitHub at the pinned commit (about 340 KB), checks their size and SHA-256 against `selection.json`, runs the generator and compares every fixture and key with the selection. It writes `.data/build/minutes-edition-8/fixtures/` and `.data/build/minutes-edition-8/keys/` and takes under a minute. Nothing calls a model.

| Option | Effect |
| --- | --- |
| `--offline` | Uses the cached generator files only. |
| `--lean-documents DIR` | Takes the generator files from a local `lean_documents` checkout that contains the commit, instead of GitHub. |
| `--data DIR` | Writes the cache and the build to `DIR` instead of `.data/`. |
| `--python PYTHON` | The Python 3 interpreter; `python3` by default. Python 3.9 and 3.12 give the same bytes. |

The build refuses to overwrite an existing build and refuses a cached generator file that no longer matches. It runs the generator from a fresh copy of the three verified files, so nothing else in the cache is loaded. A build with a missing, extra or different book file or key stays in a staging folder, which the error names, and is not moved into place. `keys.generation.json` is not hash-checked, because it records the Python version.

## Layout and Blinding

| Path | Contents | Give to the reviewer |
| --- | --- | --- |
| `fixtures/<dossier>/report-correct.md`, `report-mixed.md` | The reports to check | One report per review |
| `fixtures/<dossier>/sources/` | The minute book volumes and the procedure | Yes, with that report |
| `keys/<dossier>.json` | Answer key: every generated fact, each statement's verdict and value, and how to recompute it | Never |
| `keys.generation.json` | Generation summary; it counts the planted errors, so it is answer material | Never |

- Give a reviewing agent only a copy of one report and its `sources/` folder, in a folder that holds nothing else. Never give it this repository, `.data/`, the build root or the keys. Run reviews without network access where possible.
- Deep Proof starts reviews through ALA with your home folder as the agent home (`src/ala.mjs`), so files under your home folder may be readable by such a review. When you run reviews on the same machine, build with `--data` outside your home folder or move the keys away first.
- The generator and the seed are public, so anyone can rebuild these keys, and the books have published results. Treat them as development material, never as a held-out or final partition; [../report-quality/README.md](../report-quality/README.md) gives the rules for splitting an evaluation by document family.
- The keys written here are not sealed. `evalsuite/blindness.py seal` in `lean_documents` copies them outside the agent's folders and embeds a canary that a leak scan can find. A key used without sealing carries no canary.

## Fresh Reviews and Scoring

Reviews and scoring use `lean_documents` at the same commit, whose `evalsuite/README.md` ("A blind campaign with three contestants") describes the runner, what the agent can read and how a review is counted. In outline, with `BUILD` the build folder and `/campaign` a new folder outside the repositories:

```sh
git clone https://github.com/skutner/lean_documents.git && cd lean_documents
git checkout e36c1d7b16dc39d073a399eef7806c14e0b228c8
python3 evalsuite/blindness.py seal --source BUILD/keys --dest /campaign/sealed --agent-root /campaign/arena
python3 evalsuite/run_blind.py plan --fixtures BUILD/fixtures --keys /campaign/sealed --arena /campaign/arena \
  --out /campaign/out --arms plain --arms-file evalsuite/arms-shown-sums.json \
  --agent codex --model MODEL --effort xhigh --minutes 60 --repeats 2 --agent-home /campaign/agent-home
env -u BIG_MINUTES_EDITION python3 evalsuite/check_shown.py --campaign /campaign/out --keys /campaign/sealed --arm plain --output shown.json
```

`/campaign/agent-home` must hold only a login made for the campaign, as that README explains. `plan` starts nothing; `probe` and then `run` with the same arguments start the reviews, and only `run` calls a model. This invocation has not been run on these books: the runner's options are documented in `lean_documents`, and a fresh campaign measures its own reviews. It does not reproduce the recorded ones, which are summed in the published CSV.

## Licence and Provenance

The generator is not copied into this repository. The build fetches it from the public `skutner/lean_documents` repository at the pinned commit for local evaluation; that repository carries no licence file, so its code is not covered by this repository's licence. The books and keys are the generator's output for the recorded seed and are written only to `.data/`.

Not included: the written reports offered on deepproof.ch, the recorded review sessions and answer sheets, the sealed keys of the recorded runs, and the books of the other studies.
