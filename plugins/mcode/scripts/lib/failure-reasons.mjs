export const FAILURE_REASONS = {
  "timeout": {
    heading: "mcode delegation timed out.",
    defaultMessage: "Operation timed out."
  },
  "limit-exceeded": {
    heading: "mcode delegation exceeded step limit.",
    defaultMessage: "Step limit exceeded."
  },
  "needs-interaction": {
    heading: "mcode requires interaction that is not available in headless mode.",
    defaultMessage: "Interactive input or permission required in TUI"
  },
  "mcode-not-found": {
    heading: "mcode was not found on PATH.",
    defaultMessage: "Please install mcode or run /mcode:setup to check requirements and installation instructions."
  },
  "unsupported-output-version": {
    heading: "Unsupported mcode output version.",
    defaultMessage: "The mcode version emitted an unrecognized output stream schema."
  },
  "review-result-invalid": {
    heading: "mcode review produced an invalid result.",
    defaultMessage: "Review result was invalid or could not be parsed."
  },
  "error": {
    heading: "mcode delegation failed.",
    defaultMessage: "Unknown failure."
  }
};
