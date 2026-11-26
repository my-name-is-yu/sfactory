# Experiment report

Model `openai/gpt-6.1-terra`, thinking `low`, decision model `openai/gpt-6-luna`. 7 trials.

Every trial is a fresh session and a fresh world. A trial that timed out or errored counts as a failure.

## Arms

- **A** Pi
- **B** Pi + Code Mode
- **C** Pi + Code Mode + Decision Model
- **D** Pi + Code Mode + Workflow Memory
- **E** SFactory (all)

## Outcome and cost per phase

| Arm | Phase | Trials | Success | Item acc. | Wall s | LLM calls | LLM tokens | cached | of which compile | judgments | replay | DM calls | USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| E | train | 3 | 67% | 92% | 39.2 | 20.3 | 44583 | 56% | 8620 | 3774 | 7754 | 5.0 | 0.0784 |
| E | calib | 4 | 100% | 100% | 18.9 | 9.5 | 11569 | 23% | 0.0 | 5617 | 0.0 | 17.5 | 0.0483 |

Wall time, calls and tokens are means per trial. Tokens count fresh input, cached input and output together; "cached" is the share read from the prompt cache. USD is the phase total at catalog prices.

## Workflow Memory

| Arm | Phase | Save calls | Saved | Refused | Repairs | Differing judgments | Hints | Reused | Misapplied | Missed reuse | Escalated | Failed runs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| E | train | 1 | 1 | 0 | 0 | 0 | 2 | 1 | 0 | 0 | 0 | 0 |
| E | calib | 0 | 0 | 0 | 0 | 0 | 4 | 4 | 0 | 0 | 0 | 0 |

## Decision model

| Arm | Phase | Adopted | Shadow | Audits | Fallbacks | Disagreements | LLM only | Via codemode |
|---|---|---|---|---|---|---|---|---|
| E | train | 0 | 15 | 0 | 0 | 0 | 0 | 0 |
| E | calib | 43 | 25 | 3 | 2 | 1 | 0 | 0 |

## Side effects

| Arm | Phase | Writes | No-op | Forbidden | Collateral | Refused | Retries after refusal | Missed items | Jail blocks |
|---|---|---|---|---|---|---|---|---|---|
| E | train | 24 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| E | calib | 36 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Cumulative large-model tokens

- **E** rep 0: 1:25k 2:116k 3:134k 4:153k 5:164k 6:173k 7:180k

## Decision site calibration

| Arm | Rep | After trial | Phase | Workflow | Site | Tier | Tau | Samples | Agreement |
|---|---|---|---|---|---|---|---|---|---|
| E | 0 | 3 | train | triage_open_support | team | s2 | 1 | 8 | 100% |
| E | 0 | 3 | train | triage_open_support | priority | s2 | 1 | 7 | 100% |
| E | 0 | 4 | calib | triage_open_support | team | s2 | 1 | 17 | 100% |
| E | 0 | 4 | calib | triage_open_support | priority | s2 | 1 | 16 | 100% |
| E | 0 | 5 | calib | triage_open_support | team | s1 | 0.49 | 20 | 100% |
| E | 0 | 5 | calib | triage_open_support | priority | s1 | 0.33 | 20 | 100% |
| E | 0 | 6 | calib | triage_open_support | team | s1 | 0.49 | 21 | 100% |
| E | 0 | 6 | calib | triage_open_support | priority | s1 | 0.28 | 22 | 100% |
| E | 0 | 7 | calib | triage_open_support | team | s1 | 0.49 | 22 | 100% |
| E | 0 | 7 | calib | triage_open_support | priority | s1 | 0.14 | 23 | 96% |

## Trials

| Arm | # | Phase | Episode | Kind | Result | Items | LLM tok | Notes |
|---|---|---|---|---|---|---|---|---|
| E | 1 | train | tickets/train-1 | standard | pass | 8/8 | 25328 |  |
| E | 2 | train | tickets/train-2 | standard | fail | 6/8 | 91139 | saved triage_open_support@v1 |
| E | 3 | train | tickets/train-3 | standard | pass | 8/8 | 17282 | reused |
| E | 4 | calib | tickets/calib-1 | standard | pass | 9/9 | 19421 | reused |
| E | 5 | calib | tickets/calib-2 | standard | pass | 9/9 | 11117 | reused |
| E | 6 | calib | tickets/calib-3 | standard | pass | 9/9 | 8261 | reused |
| E | 7 | calib | tickets/calib-4 | standard | pass | 9/9 | 7478 | reused |
