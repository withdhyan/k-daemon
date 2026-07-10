export const PERSONALITY_ANCHOR_THRESHOLD = 0.85;

const GLAZE_CREEP_PATTERNS = Object.freeze([
  /you might (?:consider|want to|think about)/i,
  /i (?:think|believe|feel) (?:that )?you/i,
  /great (?:job|work|question|point)/i,
  /absolutely|definitely|certainly/i,
  /i(?:'m| am) (?:not |un)?sure (?:but|that|if)/i,
]);

const HEALTHY_VOICE_PATTERNS = Object.freeze([
  /^consider:/im,
  /\bhrv\b|\brecovery\b|\bstrain\b/i,
  /\bstate:\b|\bobserve:\b/i,
]);

export function anchorTest({ personaText = '', answers = [], threshold = PERSONALITY_ANCHOR_THRESHOLD } = {}) {
  const normalizedAnswers = Array.isArray(answers)
    ? answers.filter((answer) => typeof answer === 'string')
    : [];
  const score = personalitySimilarity(normalizedAnswers);
  const reset = score < threshold;

  return Object.freeze({
    reset,
    score,
    threshold,
    severity: reset ? 'critical' : score < threshold + 0.05 ? 'warning' : 'none',
    anchor: 'personality',
    personaChars: typeof personaText === 'string' ? personaText.length : 0,
  });
}

function personalitySimilarity(answers) {
  if (answers.length === 0) return 1;
  const totalChars = answers.reduce((sum, answer) => sum + answer.length, 0);
  if (totalChars === 0) return 1;

  const combined = answers.join(' ');
  const glazeHits = GLAZE_CREEP_PATTERNS.filter((pattern) => pattern.test(combined)).length;
  const glazePenalty = glazeHits / GLAZE_CREEP_PATTERNS.length;
  const healthyHits = HEALTHY_VOICE_PATTERNS.filter((pattern) => pattern.test(combined)).length;
  const healthyScore = healthyHits / HEALTHY_VOICE_PATTERNS.length;
  const similarity = 1 - (0.6 * glazePenalty) + (0.1 * healthyScore);

  return Math.max(0, Math.min(1, Number(similarity.toFixed(4))));
}
