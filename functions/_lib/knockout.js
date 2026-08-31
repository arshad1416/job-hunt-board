const MAX_TEXT = 12000;
const SIGNALS = [
  { reason: 'role closed', pattern: /(?:role|position|job)\s+(?:is\s+)?(?:closed|filled|no longer available)/i },
  { reason: 'explicit rejection', pattern: /(?:application|candidate|you)\s+(?:has been|have been|was)\s+(?:rejected|declined|unsuccessful)/i }
];
function assessKnockout(input) {
  const text = typeof input === 'string' ? input.trim().slice(0, MAX_TEXT) : '';
  if (!text) return { eligible: true, warning: null, reason: null };
  const hit = SIGNALS.find(s => s.pattern.test(text));
  return hit ? { eligible: true, warning: hit.reason, reason: hit.reason } : { eligible: true, warning: null, reason: null };
}
function knockoutReason(text) { return assessKnockout(text).reason; }
function isKnockoutEligible(text) { return assessKnockout(text).eligible; }
export { MAX_TEXT, assessKnockout, knockoutReason, isKnockoutEligible };
