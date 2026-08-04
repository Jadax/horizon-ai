/**
 * COMPLIANCE GATE — deterministic, free, zero-API scan run BEFORE the LLM
 * quality gate (stolen from clipforge's ad-law scanner + video-autopilot-kit's
 * legal-compliance layer). Regulatory/demonetization-risk claims are what get
 * faceless channels flagged, demonetized, or struck — not weak hooks. So we
 * catch the two genuinely dangerous classes deterministically:
 *
 *   - MEDICAL/EFFICACY claims ("cures", "clinically proven", "kills 99% of
 *     germs") → hard BLOCK: credible regulatory risk.
 *   - INCOME/FINANCIAL guarantees ("guaranteed income", "make $X", "risk-free")
 *     → hard BLOCK: deceptive-advertising risk, especially once affiliate
 *     links are in the description.
 *
 * Everything else (false urgency, absolute superlatives, unsourced
 * "studies show") is SOFT: it feeds rewrite notes back to the scriptwriter
 * instead of killing the video, so a legitimately strong short isn't
 * rejected over a common faceless-title phrase ("last chance", "best ever").
 */
export const COMPLIANCE_RULES = [
  {
    id: "medical_efficacy",
    label: "Medical / efficacy claim",
    // Only clearly-regulatory medical efficacy wording. Conservative so a
    // cooking "I cured these olives" or gaming "full heal" never false-poison.
    regex: /\b(cure\s+(?:for\s+|all\s+|any\s+)?(?:cancer|disease|illness)|clinically\s+(?:proven|tested)|medically\s+proven|kills?\s+\d+\s*%\s+of\s+(?:germs?|bacteria)|treats?\s+(?:cancer|diabetes|depression|heart\s+disease|dementia)|lose\s+\d+\s*(?:lbs|kg|pounds)\s+(?:in|per)\s+[a-z]+)\b/i,
    blocking: true,
  },
  {
    id: "financial_guarantee",
    label: "Income / financial guarantee",
    regex: /\b(guaranteed\s+income|guaranteed\s+(?:earnings?|profit)|make\s+\$\d|earn\s+\$\d|get\s+rich\s+(?:fast|quick)|double\s+your\s+(?:money|income)|risk[- ]?free\s+(?:income|money|return)|money[ -]?back\s+guarantee)\b/i,
    blocking: true,
  },
  {
    id: "false_urgency",
    label: "False urgency / scarcity",
    regex: /\b(act\s+now|limited\s+(?:time|offer|stock)|only\s+(?:today|tonight|\d+\s+left|a\s+few\s+left)|last\s+chance|ends\s+(?:tonight|today|soon)|hurry\b|don'?t\s+miss\s+out|while\s+supplies\s+last)\b/i,
    blocking: false,
  },
  {
    id: "unsourced_claim",
    label: "Unsubstantiated claim",
    regex: /\b(studies?\s+show|experts?\s+say|researchers?\s+say|everyone\s+knows|they\s+say\b)\b/i,
    blocking: false,
  },
];

export function complianceScan(title = "", description = "", script = "") {
  const haystack = `${title || ""}\n${description || ""}\n${script || ""}`;
  const blocking = [];
  const warnings = [];
  for (const rule of COMPLIANCE_RULES) {
    const m = rule.regex.exec(haystack);
    if (m) {
      const hit = { id: rule.id, label: rule.label, match: m[0] };
      (rule.blocking ? blocking : warnings).push(hit);
    }
  }
  return { blocking, warnings };
}
