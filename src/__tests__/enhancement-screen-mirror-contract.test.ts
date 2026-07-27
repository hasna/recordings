import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CONFIG } from "../lib/config.js";
import { needsEnhancement } from "../lib/enhancer.js";
import {
  matchingDelimiterIndex,
  swiftSourcesUnder,
  withoutAnyComments,
} from "./helpers/source-assertions";

/**
 * `EnhancementScreen.swift` is a hand-copied mirror of the CLI's `needsEnhancement`, and the
 * consequence of drift is a silent wrong output in the live default mode: `ProjectStore` defaults
 * `post_processing_mode` to `auto`, so a screen that says "cannot be enhanced" when the CLI would
 * have rewritten the transcript pastes raw text where the user asked for the rewrite.
 *
 * Three claims were made about why that drift cannot happen. Measured with
 * `scripts/vacuity-mutation-battery.ts`, none of them was enforced by anything runnable on Linux:
 *
 *   - "the 6 regex sources are byte-identical" — editing the Swift copy alone SURVIVED.
 *   - "the shared fixture table pins both implementations" — deleting a row from the Swift twin's
 *     table alone SURVIVED. The `enhancer.test.ts` fixtures only ever exercised the TS side; the
 *     two tables were the same text by convention, and nothing read the Swift one.
 *   - the fail-closed `enhanceTriggersJSON` contract (review F2 on #30) — dropping the argument at
 *     the production call site SURVIVED, and five call sites in `SpeechIntentTests.swift` were
 *     shipped without it at all, which does not compile.
 *
 * The Swift suites are the real check and they cannot run here: no reachable machine runs them, and
 * this repository's CI compiles `RecordingsTests` on macOS but does not execute it. These
 * assertions are text-level and deliberately so — they are the half that can run on every push.
 */

const repositoryRoot = resolve(import.meta.dir, "../..");

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

/**
 * The array literal opened by `marker`, comments removed and bracket-matched.
 *
 * Bracket matching rather than "up to the next `];`": the nearest `];` is not the array's end in
 * general, and a region assertion over the wrong text reads exactly like a satisfied one.
 */
function arrayLiteralAfter(source: string, marker: string): string {
  // Counted on the comment-stripped text, not the raw file, so the uniqueness claim is about code.
  // Counting raw would fail loudly on a marker quoted in a comment — fail-closed, but it would
  // report "not unique" about a file whose code has exactly one, and send the reader to the wrong
  // place.
  const scanned = withoutAnyComments(source);
  const occurrences = scanned.split(marker).length - 1;
  expect(occurrences, `array marker is missing entirely or not unique (${occurrences}x): ${marker}`)
    .toBe(1);
  const openIndex = scanned.indexOf(marker) + marker.length - 1;
  return scanned.slice(openIndex, matchingDelimiterIndex(scanned, openIndex, "[", "]") + 1);
}

/** Every double-quoted literal in `region`, in order. */
function quotedStrings(region: string): string[] {
  return [...region.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
}

describe("EnhancementScreen mirrors the CLI enhancement decision", () => {
  test("the instruction pattern sources are byte-identical in the CLI and the Swift mirror", () => {
    // Swift raw-string delimiters `#"…"#` and TS regex literals `/…/i` differ; the pattern text
    // between them is what has to match, and it is what both engines compile.
    const swiftSources = [
      ...arrayLiteralAfter(
        read("src/native/Recordings/RecordingsLib/EnhancementScreen.swift"),
        "static let instructionPatternSources: [String] = [",
      ).matchAll(/#"(.*?)"#/g),
    ].map((match) => match[1]);
    const cliSources = [
      ...arrayLiteralAfter(read("src/lib/enhancer.ts"), "const instructionPatterns = [").matchAll(
        /^\s*\/(.*)\/i,\s*$/gm,
      ),
    ].map((match) => match[1]);

    // Floor first: two empty lists are equal, so a comparison that extracted nothing from either
    // side would otherwise pass while asserting nothing at all.
    expect(cliSources.length, "no instruction patterns extracted from src/lib/enhancer.ts")
      .toBeGreaterThan(1);
    expect(swiftSources).toEqual(cliSources);
  });

  test("the cross-language fixture table is the same text in both suites", () => {
    const swiftFixtures = read("src/native/Recordings/RecordingsTests/EnhancementScreenTests.swift");
    const cliFixtures = read("src/__tests__/enhancer.test.ts");

    for (const [swiftMarker, cliMarker] of [
      ["static let mayEnhance: [String] = [", "const crossLanguageMayEnhance = ["],
      ["static let plainDictation: [String] = [", "const crossLanguagePlainDictation = ["],
    ] as const) {
      const swiftRows = quotedStrings(arrayLiteralAfter(swiftFixtures, swiftMarker));
      const cliRows = quotedStrings(arrayLiteralAfter(cliFixtures, cliMarker));

      expect(cliRows.length, `no fixture rows extracted for ${cliMarker}`).toBeGreaterThan(1);
      expect(swiftRows).toEqual(cliRows);
    }
  });

  test("every Swift call site of shouldPasteBeforePersistence states enhanceTriggersJSON", () => {
    // The parameter has no default on purpose: "[]" decodes to "no configured triggers", so an
    // omitted argument would fail OPEN — a transcript the helper would rewrite gets pasted raw.
    // Swift rejects the omission at compile time, but nothing this repository can run on Linux
    // does, and CI compiles RecordingsTests without executing it.
    const callSites: string[] = [];
    const missing: string[] = [];

    for (const [path, source] of swiftSourcesUnder(resolve(repositoryRoot, "src/native"))) {
      const scanned = withoutAnyComments(source);
      let from = 0;
      for (;;) {
        const at = scanned.indexOf("shouldPasteBeforePersistence(", from);
        if (at < 0) break;
        from = at + 1;
        // Skip the declaration itself: it is the one occurrence preceded by `func`.
        if (/\bfunc\s+$/.test(scanned.slice(Math.max(0, at - 24), at))) continue;
        const openIndex = at + "shouldPasteBeforePersistence(".length - 1;
        const site = `${path}:${scanned.slice(0, at).split("\n").length}`;
        callSites.push(site);
        const args = scanned.slice(openIndex, matchingDelimiterIndex(scanned, openIndex, "(", ")"));
        if (!args.includes("enhanceTriggersJSON:")) missing.push(site);
      }
    }

    // Without the floor an empty sweep — a rename, a moved file, a broken scanner — reports zero
    // offenders and reads identically to a clean one.
    expect(callSites.length, "no shouldPasteBeforePersistence call sites found under src/native")
      .toBeGreaterThan(1);
    expect(missing).toEqual([]);
  });

  // The fixture twins pin TEXT, not trigger-list handling, so the one place the two
  // implementations disagreed about a trigger list was covered by nothing: an empty configured
  // trigger. The CLI half below is executed; the Swift half is asserted on its source, because no
  // reachable machine runs the Swift suite and this is the direction that pastes the wrong text.
  test("an empty configured trigger makes both implementations fail closed", () => {
    // CLI: `lower.includes("")` is true for every string, so a single empty trigger makes the
    // helper rewrite every transcript — including speech that is otherwise plain dictation.
    const plainDictation = "meet me at noon by the north entrance";
    expect(needsEnhancement(plainDictation, { ...DEFAULT_CONFIG, enhance_triggers: [] }).needs)
      .toBe(false);
    expect(needsEnhancement(plainDictation, { ...DEFAULT_CONFIG, enhance_triggers: [""] }).needs)
      .toBe(true);

    // Swift: skipping the row (`continue`, as shipped) answered "cannot be enhanced" for every
    // transcript the CLI would have rewritten — a raw paste ahead of persistence where the user
    // asked for the rewrite. The mirror special-cases the row rather than testing it, because
    // Swift's answer for an empty needle depends on which `contains` overload resolves and no
    // machine executes the Swift suite. Asserted on the source for the same reason.
    const screen = withoutAnyComments(
      read("src/native/Recordings/RecordingsLib/EnhancementScreen.swift"),
    );
    expect(screen, "the Swift mirror must fail closed on an empty configured trigger")
      .toContain("guard !loweredTrigger.isEmpty else { return true }");
  });
});
