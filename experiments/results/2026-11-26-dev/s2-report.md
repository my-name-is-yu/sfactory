# Experiment report

Model `openai/gpt-6.1-terra`, thinking `low`, decision model `none`. 28 trials.

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
| A | train | 6 | 33% | 83% | 17.8 | 5.0 | 13960 | 61% | 0.0 | 0.0 | 0.0 | 0.0 | 0.0566 |
| A | calib | 8 | 38% | 93% | 17.0 | 5.1 | 15286 | 62% | 0.0 | 0.0 | 0.0 | 0.0 | 0.0816 |
| D | train | 6 | 50% | 92% | 39.6 | 19.5 | 53745 | 64% | 16579 | 1913 | 7631 | 0.0 | 0.1593 |
| D | calib | 8 | 50% | 94% | 31.0 | 19.5 | 18981 | 14% | 0.0 | 13116 | 0.0 | 0.0 | 0.1465 |

Wall time, calls and tokens are means per trial. Tokens count fresh input, cached input and output together; "cached" is the share read from the prompt cache. USD is the phase total at catalog prices.

## Workflow Memory

| Arm | Phase | Save calls | Saved | Refused | Repairs | Differing judgments | Hints | Reused | Misapplied | Missed reuse | Escalated | Failed runs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| D | train | 2 | 2 | 0 | 0 | 1 | 4 | 1 | 0 | 0 | 0 | 0 |
| D | calib | 0 | 0 | 0 | 0 | 0 | 8 | 8 | 0 | 0 | 0 | 0 |

## Decision model

| Arm | Phase | Adopted | Shadow | Audits | Fallbacks | Disagreements | LLM only | Via codemode |
|---|---|---|---|---|---|---|---|---|

## Side effects

| Arm | Phase | Writes | No-op | Forbidden | Collateral | Refused | Retries after refusal | Missed items | Jail blocks |
|---|---|---|---|---|---|---|---|---|---|
| A | train | 48 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| A | calib | 73 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| D | train | 49 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| D | calib | 72 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Cumulative large-model tokens

- **A** rep 0: 1:14k 2:28k 3:42k 4:61k 5:76k 6:91k 7:105k
- **A** rep 1: 1:14k 2:28k 3:42k 4:57k 5:71k 6:86k 7:101k
- **D** rep 0: 1:28k 2:136k 3:153k 4:172k 5:192k 6:211k 7:230k
- **D** rep 1: 1:24k 2:85k 3:170k 4:189k 5:208k 6:226k 7:245k

## Decision site calibration

No decision sites recorded.

## Trials

| Arm | # | Phase | Episode | Kind | Result | Items | LLM tok | Notes |
|---|---|---|---|---|---|---|---|---|
| A | 1 | train | tickets/train-1 | standard | pass | 8/8 | 13848 |  |
| A | 2 | train | tickets/train-2 | standard | fail | 5/8 | 14101 |  |
| A | 3 | train | tickets/train-3 | standard | fail | 7/8 | 13990 |  |
| A | 4 | calib | tickets/calib-1 | standard | pass | 9/9 | 19295 |  |
| A | 5 | calib | tickets/calib-2 | standard | fail | 8/9 | 14672 |  |
| A | 6 | calib | tickets/calib-3 | standard | pass | 9/9 | 14736 |  |
| A | 7 | calib | tickets/calib-4 | standard | fail | 8/9 | 14637 |  |
| A | 1 | train | tickets/train-1 | standard | pass | 8/8 | 13856 |  |
| A | 2 | train | tickets/train-2 | standard | fail | 5/8 | 13981 |  |
| A | 3 | train | tickets/train-3 | standard | fail | 7/8 | 13982 |  |
| A | 4 | calib | tickets/calib-1 | standard | pass | 9/9 | 14837 |  |
| A | 5 | calib | tickets/calib-2 | standard | fail | 8/9 | 14700 |  |
| A | 6 | calib | tickets/calib-3 | standard | fail | 8/9 | 14784 |  |
| A | 7 | calib | tickets/calib-4 | standard | fail | 8/9 | 14630 |  |
| D | 1 | train | tickets/train-1 | standard | pass | 8/8 | 28145 |  |
| D | 2 | train | tickets/train-2 | standard | fail | 6/8 | 107428 | saved triage_open_support@v1 |
| D | 3 | train | tickets/train-3 | standard | pass | 8/8 | 17342 | reused |
| D | 4 | calib | tickets/calib-1 | standard | pass | 9/9 | 19580 | reused |
| D | 5 | calib | tickets/calib-2 | standard | fail | 8/9 | 19444 | reused |
| D | 6 | calib | tickets/calib-3 | standard | fail | 8/9 | 18850 | reused |
| D | 7 | calib | tickets/calib-4 | standard | pass | 9/9 | 18824 | reused |
| D | 1 | train | tickets/train-1 | standard | pass | 8/8 | 23684 |  |
| D | 2 | train | tickets/train-2 | standard | fail | 7/8 | 61780 |  |
| D | 3 | train | tickets/train-3 | standard | fail | 7/8 | 84090 | saved triage_open_tickets@v1 |
| D | 4 | calib | tickets/calib-1 | standard | pass | 9/9 | 19209 | reused |
| D | 5 | calib | tickets/calib-2 | standard | fail | 8/9 | 19164 | reused |
| D | 6 | calib | tickets/calib-3 | standard | fail | 8/9 | 18402 | reused |
| D | 7 | calib | tickets/calib-4 | standard | pass | 9/9 | 18377 | reused |
