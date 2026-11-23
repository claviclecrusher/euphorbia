'use strict';

// Default writing rules for text the AI writes into a paper (Ctrl+K rewrites
// and chat edits). Aimed at machine learning / AI research papers. Editable in
// AI Settings; the edited text replaces this default.

const DEFAULT_STYLE = `Sentences
- Keep sentences short: aim for 15-25 words and split anything over about 30 words.
- One idea per sentence. Put the main point first, then the qualification.
- Prefer plain words: "use" (not utilize/leverage), "show" (not demonstrate/showcase), "help"
  (not facilitate), "about" (not approximately, in running text), "to" (not in order to),
  "because" (not due to the fact that).
- Cut filler: "it is worth noting that", "it should be noted that", "in this regard",
  "note that" at the start of a sentence, "very", "quite", "really".
- Avoid words that sound inflated or machine-written: delve, crucial, pivotal, paramount,
  intricate, seamless, groundbreaking, revolutionize, landscape, realm, tapestry, plethora,
  underscore, showcase, harness, elevate, unlock, robust (unless about robustness),
  comprehensive (unless it is), "a testament to".
- Prefer verbs to nouns: "we compare" rather than "we perform a comparison".
- Avoid long chains of em dashes, semicolons and nested parentheses.

Voice and tense
- Use active voice with "we" for the authors' own work: "We propose", "We show".
  Never "I", and avoid "the authors" and "one".
- Present tense for what the paper does, shows and claims, and for the method:
  "Our method reduces", "Table 2 shows". Past tense for specific experiments that were
  run: "We trained each model for 200k steps". Present perfect for prior work in general:
  "Prior work has studied".
- No contractions (do not, it is).

Claims
- Be precise and do not overclaim. Use "significantly" only for statistical significance.
  Say "state of the art" or "outperforms" only when the results in the paper support it.
- Prefer numbers to adjectives: "reduces FID from 3.4 to 2.9" rather than "greatly improves".
  Name the dataset, the metric and the baseline.
- Hedge only as much as the evidence requires ("suggests", "may"); do not stack hedges.
- Do not change the meaning, numbers, results, citations or claims of the original text
  unless the user asks for it. Do not add new claims, benefits, reasons or details that the
  original does not state, and do not drop ones it does state; rephrase what is there.
- Do not soften or strengthen a claim when rewriting: keep "outperforms" as "outperforms",
  "state of the art" as "state of the art", unless asked.

Terms and notation
- Use one term for one concept throughout; do not vary terms for style.
- Define every abbreviation at first use: "flow matching (FM)". Do not define common ones
  (GPU, CNN) unless the paper does.
- Keep the paper's existing notation and macros. Do not introduce new symbols. Define a
  symbol before or right where it is first used.
- Follow the spelling variant the document already uses (US or UK).

Paragraphs
- Start a paragraph with its topic sentence; each paragraph makes one point.
- Connect sentences with clear logical words (however, therefore, in contrast) rather than
  "Moreover"/"Furthermore" at the start of every sentence.

LaTeX conventions
- Non-breaking space before references and citations: Figure~\\ref{...}, Table~\\ref{...},
  Section~\\ref{...}, Eq.~\\eqref{...} (or the document's \\cref/\\Cref if it uses them),
  "prior work~\\cite{...}".
- Capitalize Figure, Table, Section, Appendix when followed by a number.
- Math in $...$; do not write variables as plain text. Use \\emph sparingly for emphasis,
  not \\textbf in running text.
- Do not use citations as nouns ("[3] shows"); write "prior work~\\cite{...} shows", or use
  \\citet{...} if the document already does. Never write author names that do not already
  appear in the text: do not guess them from citation keys.`;

module.exports = { DEFAULT_STYLE };
