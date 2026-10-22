const ALLOWED_VERDICTS = new Set(["approve", "needs-attention"]);
const ALLOWED_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const ROOT_REQUIRED_KEYS = ["verdict", "summary", "findings", "next_steps"];
const FINDING_REQUIRED_KEYS = [
  "severity",
  "title",
  "body",
  "file",
  "line_start",
  "line_end",
  "confidence",
  "recommendation"
];

function isPlainObject(val) {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

export function validateAdversarialReviewResult(rawOutput) {
  let data = rawOutput;
  if (typeof rawOutput === "string") {
    try {
      data = JSON.parse(rawOutput);
    } catch (err) {
      return { valid: false, error: `Invalid JSON output: ${err.message}` };
    }
  }

  if (!isPlainObject(data)) {
    return { valid: false, error: "Output must be a JSON object" };
  }

  const rootKeys = Object.keys(data);
  if (rootKeys.length !== ROOT_REQUIRED_KEYS.length || !ROOT_REQUIRED_KEYS.every((k) => k in data)) {
    return { valid: false, error: `Output properties must be exactly: ${ROOT_REQUIRED_KEYS.join(", ")}` };
  }

  if (!ALLOWED_VERDICTS.has(data.verdict)) {
    return { valid: false, error: `verdict must be "approve" or "needs-attention", got "${data.verdict}"` };
  }

  if (typeof data.summary !== "string") {
    return { valid: false, error: "summary must be a string" };
  }

  if (!Array.isArray(data.next_steps) || !data.next_steps.every((s) => typeof s === "string")) {
    return { valid: false, error: "next_steps must be an array of strings" };
  }

  if (!Array.isArray(data.findings)) {
    return { valid: false, error: "findings must be an array" };
  }

  for (let i = 0; i < data.findings.length; i += 1) {
    const f = data.findings[i];
    if (!isPlainObject(f)) {
      return { valid: false, error: `findings[${i}] must be an object` };
    }

    const findingKeys = Object.keys(f);
    if (findingKeys.length !== FINDING_REQUIRED_KEYS.length || !FINDING_REQUIRED_KEYS.every((k) => k in f)) {
      return { valid: false, error: `findings[${i}] properties must be exactly: ${FINDING_REQUIRED_KEYS.join(", ")}` };
    }

    if (!ALLOWED_SEVERITIES.has(f.severity)) {
      return { valid: false, error: `findings[${i}].severity must be critical, high, medium, or low` };
    }

    if (typeof f.title !== "string" || typeof f.body !== "string" || typeof f.file !== "string" || typeof f.recommendation !== "string") {
      return { valid: false, error: `findings[${i}] string properties must be strings` };
    }

    if (!Number.isInteger(f.line_start) || !Number.isInteger(f.line_end)) {
      return { valid: false, error: `findings[${i}] line_start and line_end must be integers` };
    }

    if (typeof f.confidence !== "number" || Number.isNaN(f.confidence) || f.confidence < 0 || f.confidence > 1) {
      return { valid: false, error: `findings[${i}].confidence must be a number between 0 and 1` };
    }
  }

  return { valid: true, value: data };
}
