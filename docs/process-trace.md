# Process Trace, Version 1

The process trace is an opt-in journal of one analysis or Check Report run: the steps Deep Proof takes, every event and diagnostic line ALA reports, and, for a Check Report, a copy of its disposable work folder taken before Deep Proof removes it. It is written for a human reader, for example the read-only Deep Proof process viewer in lean_documents. It is a convenience record, not evidence, and it is not tamper-proof.

This file is the contract between Deep Proof, which writes the trace, and every program that reads it. The code is `src/trace.mjs`; `tests/fixtures/trace-v1-sample.jsonl` is a golden sample of a complete trace.

## Switch

The trace is on only when the environment variable `DEEP_PROOF_TRACE` is exactly `1` when the server creates the run. Any other value, or no value, is off. Set it when starting the server:

```sh
DEEP_PROOF_TRACE=1 npm start
```

Off means exactly today's behaviour: no `traces` folder, no extra file, no extra work. The switch is read once per run, when the run is created; skill generation runs are never traced. `createApp({env})` takes the environment to read; by default it is the server's own. The benchmark runner (`tests/evaluation/benchmarks/runner.mjs`) calls `createApp({dir:dataDir})`, so its private Deep Proof instances take the switch from the runner's environment.

## Location

```
<data>/projects/<project-id>/traces/<run-id>/trace.jsonl
<data>/projects/<project-id>/traces/<run-id>/workspace/
```

`<data>` is `ANALYST_DATA_DIR`, or `.runtime/` in the application folder. The trace lies beside the run folder (`projects/<project-id>/analyses/<run-id>/`), not inside it: for an analysis the run folder is the agent's working folder, and a journal growing there would change what the agent sees. Folders are created with mode 0700, files with mode 0600. Deleting a project deletes its traces. To delete only the traces, delete `projects/<project-id>/traces/`.

## File Format

UTF-8 JSON Lines: one JSON object per line, each ended by `\n`. Each record is written by one `write` call on a descriptor opened once per run with create-exclusive, append and no-follow (on macOS no symbolic link in any component of the path). If the file already exists, if a component of its path is a symbolic link or not a folder, or if the open fails for any other reason, the trace for that run is disabled and the run continues untraced.

Every record has these common fields:

| Field | Meaning |
| --- | --- |
| `seq` | Integer from 1, plus 1 for each record. |
| `at` | Time of writing, ISO 8601 UTC with milliseconds. |
| `type` | The record type below. |

Records are in write order. An `ala-event` or `ala-stderr` line may follow the `turn-end` of its turn; readers group by `turn`. When the time limit kills ALA, stderr lines not yet read are lost, as they are for Deep Proof's own progress control.

`turn` is always a string: the label used in the work folder's file names, `1`, `1-continue1`, `2`, `3` or `wrapup`. `attempt` is a number, or `wrapup`.

## Record Types

| `type` | Fields besides the common ones | Written when |
| --- | --- | --- |
| `run-start` (always `seq` 1) | `schema` `"deep-proof-trace"`, `version` 1, `runId`, `projectId`, `projectName`, `kind` (`analysis` or `quality`), `createdAt`, `title` (the title of the report under review for `quality`, else null), `sourceReport` (null or `{id,kind,title,documentId}`), `skill` `{id,name,revision,methodologyRevision,verification}`, `agent`, `model`, `effort`, `reportLanguage`, `timeLimitMinutes`, `workMs`, `wrapUpMs`, `maxAttempts`, `qualityOptions` (null or `{depth,researchMode}`), `documents` `[{id,title,fileType,originalName,bytes,sha256}]` (size and SHA-256 of the document's Markdown as UTF-8 bytes, the bytes written to `sources/<id>.md`), `runFolder` (`projects/<pid>/analyses/<rid>`), `server` `{pid,startedAt}`, `limits` `{recordBytes,traceBytes}` | The run row has been inserted. |
| `workspace-created` | `path` (absolute path of the Check Report work folder) | The work folder is handed to the task. `quality` only. |
| `turn-start` | `turn`, `attempt`, `repair` (a repair attempt after a failed validation), `continuation` (an empty response continued), `resume` (the ALA session is resumed), `sessionId`, `taskFile` (`task-<turn>.txt` in the working folder), `promptBytes`, `promptSha256`, `remainingMs` | The task file has been written, before ALA is started. |
| `ala-event` | `turn`, `event` (the parsed object after `@@ALA_EVENT@@`, keys and order as ALA wrote them), optional `truncated` `{field,originalBytes}` with optional `path` and `clippedStrings` (see Size Bounds) | A stderr line starts with the prefix and parses as an object. |
| `ala-stderr` | `turn`, `text`, optional `truncated` `{originalBytes}` | Any other non-empty stderr line, or an event line that does not parse. |
| `reminder-sent` | `turn`, `id` | A progress reminder was written to ALA's input. Its acceptance or rejection arrives as an `ala-event` (`message-accepted`, `message-rejected`). |
| `progress-note` | `turn`, `text` (the last block of `progress.md`, at most 1,800 characters), `blocks` | Deep Proof sees `progress.md` change. |
| `turn-end` | `turn`, `outcome` (`exited`, `time_limit`, `spawn_error`), `exitCode` (integer or null), `signal` (string or null), `durationMs`, optional `error` (the last 3,000 characters) | The turn ends. |
| `continuation` | `attempt`, `reason` `"empty_response"`, `used` | An empty response is retried in the same session. |
| `validation` | `attempt`, `valid`, `errorCount`, `errors` (at most 100 strings of at most 2,000 characters; an error that is not a string is stored as its JSON text) | After each validation, passed or failed, including `wrapup`. |
| `time-limit` | `elapsedMs`, `workMs` | The run catches the time-limit error. |
| `wrap-up` | `phase` (`start`, `validated`, `not-validated`), optional `remainingMs` | Around the wrap-up turn. |
| `published` | `what` (`report`, `check-report`, `time-limit-notes`), `timeLimited` | The result was written to the run folder. |
| `workspace-kept` | `files`, `bytes`, `skippedCount`, `skipped` (the first 50 `{name,reason}`), `excluded` (the excluded top-level entries that were present), `complete`, `durationMs` | The copy of the work folder finished, before the folder is removed. |
| `workspace-keep-failed` | `message` | The copy could not be made. |
| `trace-limit` | `traceBytes` | The trace reached its size limit. |
| `run-end` | `status` (`completed`, `failed`), `timeLimited`, `partial`, `failureCode` (null or `empty_response`, `interrupted`, `timeout`, `validation`, `access`, `engine`, `unexpected`), `error` (null or the first 12,000 characters), `quality` (null or `{completion,confirmedFindings}`), `droppedAlaLines`, `durationMs` (from `createdAt`) | After the run row has been updated. |

`run-end` is written once and closes the trace. When the run's final state could not be stored (both database updates failed), `run-end` says `status` `failed`, `failureCode` `unexpected` and `error` "Deep Proof could not store the final state of this run."; the run row then stays `running` until the next start of the server marks it failed. A trace without `run-end` belongs to a run that is still going or to a server that stopped.

Reasons in `skipped`: `link`, `hard-link` (a file with a second name), `not-regular`, `too-large`, `depth`, `unreadable`, and, where the copy stopped, `file-limit`, `byte-limit` or `time` (the name is `.` when the copy stopped before its first entry).

Event keys are kept as ordinary keys, including one named `__proto__`; readers must not merge an event into an object with prototype semantics.

## Size Bounds

| Bound | Value | Behaviour |
| --- | --- | --- |
| One record | 262,144 bytes of text per string field, at any depth | The string is clipped at a character boundary. In an `ala-event`, `truncated` describes the largest cut: `field` is the top-level key under which it lies and `originalBytes` its length before clipping; `path` (only when the string is nested) is the list of keys and array indexes from the event to it, starting with `field`; `clippedStrings` (only when more than one string was cut) is the number of cuts. A single clipped top-level field therefore still gives `{field,originalBytes}`. An event nested deeper than 64 levels or holding more than 100,000 values is not walked: its line is stored as `ala-stderr` text (clipped like any line). A stderr line over 1,048,576 bytes is not parsed and is stored clipped as `ala-stderr`. |
| One trace file | 67,108,864 bytes | One `trace-limit` record; later ALA lines are counted in `droppedAlaLines`, not written; Deep Proof's own step records are still written. |
| Kept copy, one file | 8,388,608 bytes | Skipped and listed in `skipped` as `too-large`. |
| Kept copy, total | 67,108,864 bytes, 2,000 files, 10 seconds | The copy stops; `complete` is false. The 10 seconds are checked between files. |
| Kept copy, hard bound | 12 seconds | Whatever the copy is doing (for example a file-system call that does not return), the hook settles and the work folder is removed. A `workspace-kept` record with `complete` false lists the entry being copied as `time` (or `workspace-keep-failed` if the copy had not started). The abandoned copy writes no further file or record, stops at its next step, and never writes to or recreates the work folder. |
| Kept copy, depth | 8 levels below the work folder | A folder whose entries would lie deeper is not copied and is listed as `depth`; the copy goes on and `complete` is false. |

## Kept Work Folder Copy

A Check Report runs in a private temporary folder that Deep Proof removes when the run ends. With the trace on, the folder is copied to `traces/<run-id>/workspace/` first: on success, on failure and at the time limit, always before the removal. Copied: every regular file with one name reached without a symbolic link, except the top-level entries `skills`, `validation`, `sources`, `input.json` and `evidence-lines.json`. That keeps the prompts (`task.txt`, `task-*.txt`), the responses (`response-*.txt`), the validation results, `progress.md`, the draft `report.md`, `quality/`, `quality-input/`, `charts/`, the ALA session transcript in `.ala/sessions/`, `config.json`, `output-contract.json` and whatever else the agent wrote. Left out because bulky or found elsewhere: the skill copies, the validator copy, the sources (already in the run folder), `input.json` (its needed facts are in `run-start`) and `evidence-lines.json`.

The copy is made file by file without blocking the server. A failing or slow copy never stops the removal of the work folder and never changes the run's result or error; its own time bound is 10 seconds, checked between files, with a hard bound of 12 seconds after which the copy is abandoned. Because the copy runs between the publication of a Check Report and the update of its run row, a server crash in those seconds marks an already published check as failed at the next start ("Server restarted before this run completed."). After a server crash nothing is copied and nothing is removed: the work folder stays where `workspace-created` says.

## Guarantees

- No trace call throws. The first failure disables the trace for that run and prints one line to the server's error output; the run goes on unchanged.
- The trace never changes a run's result, error or stored status: `run-end` is written after the run row is updated.
- The trace is never part of `verification-index.json`, the verification bundle, `input.json`, the run row, the run API or the PDF. No Deep Proof HTTP route serves it.
- Version 1 may gain record types and fields. Removing one, or changing its meaning, needs version 2. Readers show an unknown type as "Other step".

## Confidentiality

The trace and the kept copy hold dossier text, prompts, agent output and ALA's stderr, which can contain account diagnostics and installation paths. Deep Proof's project access rules do not apply to anyone who can read the data folder. A run started from the UI on macOS can write below the user's home, so a run could alter its own trace.
