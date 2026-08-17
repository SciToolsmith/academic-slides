#!/usr/bin/env node

import assert from "node:assert/strict";
import { createPresentationFromSpec, internal } from "../scripts/presentation-core.mjs";

const PROFILE_FONTS = {
  zh: "Microsoft YaHei",
  zhFallbacks: ["PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC"],
  en: "Arial",
  serif: "Times New Roman",
  math: "Latin Modern Math",
};

async function main() {
  assert.doesNotThrow(() => internal.validateThemeFontOverrides({
    heading: "PingFang SC",
    body: "PingFang SC",
    latin: "Arial",
    math: "Latin Modern Math",
  }, PROFILE_FONTS, "final_defense"));

  assert.throws(
    () => internal.validateThemeFontOverrides({ heading: "PingFang SC", body: "Source Han Sans SC" }, PROFILE_FONTS, "final_defense"),
    /uses one CJK typeface/,
    "different heading/body CJK fonts must not be silently collapsed",
  );

  for (const [role, font] of [
    ["heading", "Heiti SC"],
    ["body", "Heiti SC"],
    ["latin", "Calibri"],
    ["math", "Cambria Math"],
  ]) {
    assert.throws(
      () => internal.validateThemeFontOverrides({ [role]: font }, PROFILE_FONTS, "final_defense"),
      (error) => error instanceof Error
        && error.message.includes(`theme.fonts.${role}`)
        && error.message.includes(font)
        && error.message.includes("LibreOffice"),
      `${role} should reject a font outside the profile design tokens`,
    );
  }

  const invalidDeck = {
    profile: "final_defense",
    theme: {
      fonts: {
        heading: "Microsoft YaHei",
        body: "Heiti SC",
        latin: "Arial",
        math: "Latin Modern Math",
      },
    },
    slides: [{ id: "font-gate-runs-before-render" }],
  };
  await assert.rejects(
    () => createPresentationFromSpec(invalidDeck, { tokens: { fonts: PROFILE_FONTS } }),
    /Theme font "Heiti SC" at theme\.fonts\.body.*missing glyphs\/tofu in LibreOffice/s,
  );

  console.log("font-portability.test.mjs: PASS");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
