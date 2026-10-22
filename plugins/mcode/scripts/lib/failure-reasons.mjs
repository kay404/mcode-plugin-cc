export const JOB_KIND_NOUNS = {
  delegate: "delegation",
  review: "review",
  "adversarial-review": "adversarial review"
};

export function getFailureHeading(reason, noun = "delegation") {
  const config = FAILURE_REASONS[reason] ?? FAILURE_REASONS.error;
  return typeof config.heading === "function" ? config.heading(noun) : config.heading;
}

export const FAILURE_REASONS = {
  "timeout": {
    heading: (noun = "delegation") => `mcode ${noun} timed out.`,
    defaultMessage: "Operation timed out."
  },
  "limit-exceeded": {
    heading: (noun = "delegation") => `mcode ${noun} exceeded step limit.`,
    defaultMessage: "Step limit exceeded."
  },
  "needs-interaction": {
    heading: () => "mcode requires interaction that is not available in headless mode.",
    defaultMessage: "Interactive input or permission required in TUI"
  },
  "mcode-not-found": {
    heading: () => "mcode was not found on PATH.",
    defaultMessage: "Please install mcode or run /mcode:setup to check requirements and installation instructions."
  },
  "unsupported-output-version": {
    heading: () => "Unsupported mcode output version.",
    defaultMessage: "The mcode version emitted an unrecognized output stream schema."
  },
  "schema-invalid": {
    heading: (noun) => `mcode ${noun} output did not match the required schema.`,
    defaultMessage: "Structured output did not match the expected schema."
  },
  "error": {
    heading: (noun = "delegation") => `mcode ${noun} failed.`,
    defaultMessage: "Unknown failure."
  }
};
