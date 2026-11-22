# mend — one patch tool for every AI edit format

Entry for make.fun's **"Build mend — one patch tool for every AI edit format"**
bounty ($100 in USDC): one program, `main.ts`, that applies AI-written edits
to a tree of text files, exactly as `SPEC.md` says.

## What it does

Models write edits in four formats, and mend reads all of them:

1. **Unified diffs** — with wrong line numbers, drifted whitespace and
   indentation, blank context lines without their leading space, prose and
   code fences around the patch, CRLF files, files without a final line
   break. Hunks are matched at the first of three tiers (exact, trailing
   whitespace, both ends) and taken at the occurrence nearest the hunk's
   line number.
2. **SEARCH/REPLACE blocks** — matched at the same three tiers, failing
   `ambiguous` when the old text occurs more than once.
3. **V4A patches** — Add / Delete / Update sections, `@@` anchors with a
   cursor, `*** End of File` anchoring, `*** Move to:`.
4. **JSON tool calls** — `create`, `str_replace`, `insert`, as one array or
   JSON Lines.

Every edit is checked for safe paths first; a failed edit changes nothing
and the edits after it still run, so every failure is reported; when any
edit fails, no file is written at all. A move prints as one `R old -> new`
line. `--check` does everything but write; `--strict` matches lines exactly.

## Run

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the patch file, or `-` / absent for standard input. Node 22 and
its standard library alone — nothing is installed.

## Practice score

1,000 / 1,000 on the kit's practice set (100 of 100 checks pass).
