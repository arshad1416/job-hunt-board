const MAX_TEXT = 12000;
const MAX_WARNING = 80;
const SIGNALS = [
  { reason: 'role closed', pattern: /(?:role|position|job)\s+(?:is\s+)?(?:closed|filled|no longer available)/i },
  { reason: 'explicit rejection', pattern: /(?:application|candidate|you)\s+(?:has been|have been|was)\s+(?:rejected|declined|unsuccessful)/i }
];
function normalizeInput(value) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, MAX_TEXT) : '';
}
function assessKnockout(input) {
  const text = normalizeInput(input);
  const hit = text && SIGNALS.find(s => s.pattern.test(text));
  const warning = hit ? hit.reason.slice(0, MAX_WARNING) : null;
  return { eligible: true, warning, reason: warning };
}
function knockoutReason(text) { return assessKnockout(text).reason; }
function isKnockoutEligible(text) { return assessKnockout(text).eligible; }
export { MAX_TEXT, MAX_WARNING, normalizeInput, assessKnockout, knockoutReason, isKnockoutEligible };
