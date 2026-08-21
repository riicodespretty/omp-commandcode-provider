# Simplify

ASD-STE100 **Simplified Technical English** (Issue 9) as a Vale style.

STE exists so that a reader cannot misread an instruction: it fixes a controlled vocabulary, one meaning
per word, a small set of verb forms, and hard limits on sentence and paragraph length. This style checks
the part of that discipline a linter can see.

## Rules

| Rule | STE | Check | Level | What it flags |
|---|---|---|---|---|
| `Dictionary` | 1.1 | substitution | warning | 1056 unapproved words, each mapped to its approved replacement |
| `UnapprovedWords` | 1.1 | existence | warning | 64 unapproved words STE gives no one-word replacement for — rewrite the sentence |
| `SlangAndJargon` | 1.10 | existence | warning | Slang, colloquialism, and jargon used as a technical noun |
| `AmericanSpelling` | 1.14 | substitution | error | British and Commonwealth spellings |
| `NounClusters` | 2.1 | sequence | suggestion | Multi-word nouns longer than three words |
| `VerbForms` | 3.1–3.4 | existence | warning | Progressive, perfect, and conditional-modal verb forms |
| `IngForms` | 3.5 | existence | warning | `-ing` used as anything but a technical noun or its modifier |
| `PassiveVoice` | 3.6 | existence | warning | Passive voice (permitted only when the agent is unknown) |
| `Nominalization` | 3.7 | substitution | warning | An action buried in a noun — `do the removal of` → `remove` |
| `Contractions` | 4.2 | substitution | error | Contractions and omitted words |
| `SentenceLengthProcedural` | 5.1 | occurrence | warning | Procedural sentences over 20 words |
| `OneInstructionPerSentence` | 5.2 | existence | warning | Two coordinated instructions in one sentence |
| `ImperativeInstructions` | 5.3 | existence | warning | An instruction written as a description |
| `NotesGiveInformation` | 5.5 | existence | warning | An instruction inside a `NOTE:` block |
| `SentenceLengthDescriptive` | 6.3 | occurrence | suggestion | Descriptive sentences over 25 words |
| `ParagraphLength` | 6.6 | occurrence | warning | Paragraphs over six sentences |
| `SafetyInstructions` | 7.1–7.3 | existence | suggestion | A hazard statement with no approved risk label |
| `Semicolons` | 8.1 | existence | error | The semicolon, the one mark STE forbids outright |
| `RestrictedMeanings` | 9.2 | substitution | warning | An approved word used outside its approved sense |
| `PhrasalVerbs` | 9.3 | substitution | warning | Phrasal verbs, mapped to single approved verbs |
| `ConjunctionThat` | GR-1 | existence | suggestion | A subordinate clause with no `that` to introduce it |
| `Pronouns` | GR-3 | existence | warning | Unapproved and ambiguous pronouns |
| `AmbiguousThis` | GR-4 | existence | suggestion | `This` with no noun to anchor it |
| `FalseFriends` | GR-5 | substitution | suggestion | False friends — `disposition`, `eventual`, `actual` |
| `LatinAbbreviations` | GR-6 | substitution | error | `e.g.`, `i.e.`, `etc.` and the rest |
| `GenderNeutral` | GR-7 | substitution | warning | Gendered pronouns and job titles |
| `Possessives` | GR-8 | existence | suggestion | Saxon genitive, where `of the ...` is safer |

`error` marks what STE states absolutely. `warning` marks a reliable detection. `suggestion` marks a rule
that is right more often than not but needs a human to confirm.

## Use it

```ini
StylesPath = styles
MinAlertLevel = suggestion

[*.md]
BasedOnStyles = Simplify
```

Pick **one** sentence-length rule for your document type and switch the other off — procedural writing gets
20 words, descriptive writing gets 25, and running both at once double-reports the same sentence:

```ini
Simplify.SentenceLengthDescriptive = NO
```

### Technical nouns

STE rules 1.5, 1.6, and 1.12 let a technical noun or technical verb escape the controlled vocabulary
entirely, as long as your project defines it. That escape hatch is a Vale vocabulary, not an edit to these
rules. Add your domain terms to `styles/config/vocabularies/Simplify/accept.txt` and switch it on with
`Vocab = Simplify`. Words listed there stop being flagged by every rule in the style.

## What this style does not check

STE has 61 numbered rules and general recommendations. Some are not visible to a regular expression, and
this package does not pretend otherwise:

- **One meaning per word (rule 1.3).** `Dictionary` sees spelling, not sense. A word used in the wrong
  approved meaning passes.
- **Part of speech (rules 1.2, 1.7, 1.13).** Vale substitutions match text, not grammar. `switch`, `light`,
  and a dozen other noun/verb pairs carry a guard so they stay quiet in noun position, but the general case
  needs a human. This is why several word rules sit at `suggestion`.
- **STE word counting (rules 8.4–8.7).** STE counts a parenthetical, a hyphenated compound, a number with
  its unit, an abbreviation, a quoted string, and a multi-word proper noun as **one** word each. Vale's
  `occurrence` check counts tokens by one regex, so the two sentence-length rules approximate that count.
  A sentence dense with measurements may be reported as longer than STE would call it.
- **Structure and flow (rules 6.1, 6.2, 6.4, 6.5, 9.1, 9.4).** Giving information gradually, one topic per
  paragraph, and consistent wording across a procedure are editorial judgments, not patterns.
- **Engine limits.** Vale's regexp2 engine slows superlinearly on a single multi-hundred-KB sentence and
  aborts on invalid UTF-8 input. Both are Vale engine behaviors, not rule defects. Keep inputs valid UTF-8.
- **Block context (rules 7.1–7.3).** `SafetyInstructions` reads one paragraph at a time, so it sees a risk
  label only when the label sits in the same paragraph as the hazard sentence. It is a `suggestion` for
  that reason.
