---
name: workflow-compile
description: Compile a task you have solved more than once into a saved workflow (a wf_* tool) with workflow_trace and workflow_save. Use when a request repeats an earlier run, when sfactory hints that it resembles one, or when the user asks to make a task reusable. Do not use for one-off work.
---

# Compile a workflow

A workflow is a JavaScript program that redoes a task you already solved, for new input, without you
re-deriving the steps. It is admitted only if it reproduces recorded runs exactly, so write it from
the recordings, not from memory.

## Steps

1. Finish the current task first, with your ordinary tools.
2. `workflow_trace()` lists recorded runs; the run in progress is listed first and is also
   addressable as `"current"`. `workflow_trace({ id })` shows one run's calls;
   `workflow_trace({ id, seq })` prints one result in full. Read every run you will use as an example.
3. Compare the runs. What differs between them is the **input**. What is the same is the **program**.
4. Write the code and call `workflow_save`. If replay fails, the reply says which call did not
   match; fix the code and save again.

Prefer two example runs with different inputs. One run cannot show which values are parameters.

## The program

The code is the body of an async function in a sandbox. There is no file system, network or timer;
everything goes through these:

```js
input                                   // the validated workflow input (your input_schema)
await tools.<name>(args)                // only the tools the example runs used
await decide({ id, state, type, instructions, criteria })  // a bounded judgment
await ask(prompt, state, schema)        // a small typed generation
await escalate(reason, state)           // stop and hand back to the main model
text(value), console.log(...)           // output
return value                            // the result, as JSON
```

A tool call resolves to the tool's structured result when it has one, otherwise to its text, and
rejects with an `Error` when the tool fails. `workflow_trace` shows exactly what each call returned.

### Use plain code for everything that is determined

Loops, filters, sorting, lookups, formatting, arithmetic, branching on a field: write code.

### Use `decide` only where the run needed reading comprehension

A decision point is a place where you read unstructured content and picked one of a few options.

```js
const d = await decide({
  id: "category",                      // stable name for this decision site; never build it from data
  state: { subject: t.subject, body: t.body },   // only what the judgment needs
  type: "choice",                      // "choice" | "bool" | "score"
  instructions: "Which team should handle this support ticket?",
  criteria: { billing: "Charges, refunds, invoices", bug: "Something is broken", account: "Login and settings" },
});
// d.answer is the label ("choice"), true/false ("bool") or a level index ("score")
```

- `bool`: `criteria: { true: "...", false: "..." }`. `score`: `criteria: ["lowest", ..., "highest"]`.
- Write the criteria so they reproduce the judgments in the recorded runs: replay compares the
  resulting tool calls with the recorded ones.
- If no option fits, the run escalates by itself. Do not add a catch-all option to avoid that.
- A fast decision model takes a site over once it has agreed with the LLM often enough. Small state
  and clear criteria make that happen sooner.

### Use `ask` for short generated text

```js
const reply = await ask("Draft a short, polite reply to this ticket.", { subject, body }, {
  type: "object", properties: { body: { type: "string" } }, required: ["body"],
});
```

Replay cannot reproduce generated text, so a recorded call whose arguments contain it can never
match. List such calls in `ignore`, and say so in your reply to the user.

### Use `escalate` for anything the runs did not cover

An unexpected shape, an empty result where there should be data, a value outside the known set:
`await escalate("why", { what the main model needs to continue })`. Escalating is correct behavior.
Guessing is not.

### End with a check

Before `return`, compare what you changed with what you intended, and throw if it does not match. A
workflow that returns success on a wrong result is the worst failure there is.

Check with the values the effect calls returned. Add a read-back call only if the recorded runs
made that same read-back after their effects: replay answers a read with what was recorded, so a
read the runs never made cannot match, and one they made only *before* the effects returns the old
state.

## What replay enforces

- Every tool call the program makes must equal a recorded call: same tool, same arguments. Order
  does not matter, and calls may run in parallel with `Promise.all`.
- Every recorded `EFFECT` call must be made, unless its `seq` is in that example's `ignore`. Ignore
  only exploration (a stray `ls`) and calls with generated text.
- Reads the recorded run made that the program does not need can simply be left out.
- Values that came from the request belong in `input`. A literal copied from one run fails on the
  other run.

## The description

`description` is all a future model sees when it decides whether to call the workflow. State what
it does, when to use it, and when **not** to. A description that is too broad makes a past success
get in the way of a new problem.
