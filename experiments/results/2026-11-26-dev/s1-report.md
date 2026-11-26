# Experiment report

Model `openai/gpt-6.1-terra`, thinking `low`, decision model `none`. 9 trials.

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
| D | train | 9 | 56% | 93% | 44.6 | 18.7 | 45668 | 60% | 9738 | 3229 | 6586 | 0.0 | 0.2193 |

Wall time, calls and tokens are means per trial. Tokens count fresh input, cached input and output together; "cached" is the share read from the prompt cache. USD is the phase total at catalog prices.

## Workflow Memory

| Arm | Phase | Save calls | Saved | Refused | Repairs | Differing judgments | Hints | Reused | Misapplied | Missed reuse | Escalated | Failed runs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| D | train | 3 | 3 | 0 | 0 | 2 | 6 | 3 | 0 | 0 | 0 | 0 |

## Decision model

| Arm | Phase | Adopted | Shadow | Audits | Fallbacks | Disagreements | LLM only | Via codemode |
|---|---|---|---|---|---|---|---|---|

## Side effects

| Arm | Phase | Writes | No-op | Forbidden | Collateral | Refused | Retries after refusal | Missed items | Jail blocks |
|---|---|---|---|---|---|---|---|---|---|
| D | train | 73 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Cumulative large-model tokens

- **D** rep 0: 1:29k 2:137k 3:158k
- **D** rep 1: 1:25k 2:104k 3:120k
- **D** rep 2: 1:30k 2:117k 3:134k

## Decision site calibration

No decision sites recorded.

## Trials

| Arm | # | Phase | Episode | Kind | Result | Items | LLM tok | Notes |
|---|---|---|---|---|---|---|---|---|
| D | 1 | train | tickets/train-1 | standard | pass | 8/8 | 29041 |  |
| D | 2 | train | tickets/train-2 | standard | fail | 7/8 | 107501 | saved triage_open_support@v1 |
| D | 3 | train | tickets/train-3 | standard | pass | 8/8 | 20971 | reused |
| D | 1 | train | tickets/train-1 | standard | pass | 8/8 | 24886 |  |
| D | 2 | train | tickets/train-2 | standard | fail | 6/8 | 78619 | saved triage_open_tickets@v1 |
| D | 3 | train | tickets/train-3 | standard | fail | 7/8 | 16250 | reused |
| D | 1 | train | tickets/train-1 | standard | pass | 8/8 | 29796 |  |
| D | 2 | train | tickets/train-2 | standard | fail | 7/8 | 86772 | saved triage_open_tickets@v1 |
| D | 3 | train | tickets/train-3 | standard | pass | 8/8 | 17180 | reused |
