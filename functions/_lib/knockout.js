const SIGNALS = [
  { reason: 'role closed', pattern: /(?:role|position|job)\s+(?:is\s+)?(?:closed|filled|no longer available)/i },
  { reason: 'explicit rejection', pattern: /(?:we|your application)\s+(?:have been|has been|was)\s+(?:rejected|unsuccessful|declined)/i },
  { reason: 'work authorization required', pattern: /(?:must|requires?)\s+(?:be|have)\s+(?:authorized|eligible)\s+to work/i },
  { reason: 'location requirement', pattern: /must\s+be\s+(?:located|based)\s+in/i }
];

/** Return the first explicit, auditable JD signal; ambiguous text is eligible. */
function assessKnockout(text) {
  if (typeof text !== 'string' || !text.trim()) return { eligible: true, reason: null, signal: null };
  for (const signal of SIGNALS) if (signal.pattern.test(text)) return { eligible: false, reason: signal.reason, signal: signal.pattern.source };
  return { eligible: true, reason: null, signal: null };
}
function knockoutReason(text) { return assessKnockout(text).reason; }
function isKnockoutEligible(text) { return assessKnockout(text).eligible; }
export { assessKnockout, knockoutReason, isKnockoutEligible };
