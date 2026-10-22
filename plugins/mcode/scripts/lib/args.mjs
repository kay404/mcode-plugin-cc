export const DELEGATE_OPTION_CONFIG = {
  valueOptions: ["model", "effort"],
  booleanOptions: ["read-only", "full", "resume", "fresh", "background", "json"],
  supportedHint: "--read-only, --full, --resume, --fresh, --model <value>, --effort <value>, --background, --json"
};

export const DELEGATE_WORKER_OPTION_CONFIG = {
  valueOptions: ["job-id"],
  booleanOptions: [],
  supportedHint: "--job-id <id>"
};

export const SETUP_OPTION_CONFIG = {
  valueOptions: [],
  booleanOptions: ["json"],
  supportedHint: "--json"
};

export const RESUME_CANDIDATE_OPTION_CONFIG = {
  valueOptions: [],
  booleanOptions: ["json"],
  supportedHint: "--json"
};

export const STATUS_OPTION_CONFIG = {
  valueOptions: ["timeout-ms"],
  booleanOptions: ["all", "json", "wait"],
  supportedHint: "--wait, --timeout-ms <ms>, --all, --json"
};

export const RESULT_OPTION_CONFIG = {
  valueOptions: [],
  booleanOptions: ["all", "json"],
  supportedHint: "--all, --json"
};

export const CANCEL_OPTION_CONFIG = {
  valueOptions: [],
  booleanOptions: ["json"],
  supportedHint: "--json"
};

export const REVIEW_OPTION_CONFIG = {
  valueOptions: [],
  booleanOptions: ["background", "wait", "json"],
  supportedHint: "--wait, --background, --json"
};

export const ADVERSARIAL_REVIEW_SUPPORTED_HINT = "--base <ref>, --plan <path>, --wait, --background, --json";

export function splitSubcommandArgs(rawArgs) {
  if (rawArgs.length === 1) {
    return rawArgs[0].trim().split(/\s+/).filter(Boolean);
  }
  return rawArgs;
}

export function parseAdversarialReviewArgs(rawTokens) {
  const tokens = splitSubcommandArgs(rawTokens);
  const options = {};
  let focusTokens = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token === "--") {
      focusTokens = tokens.slice(i + 1);
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      focusTokens = tokens.slice(i);
      break;
    }

    if (token === "--wait") {
      options.wait = true;
      i += 1;
      continue;
    }

    if (token === "--background") {
      options.background = true;
      i += 1;
      continue;
    }

    if (token === "--json") {
      options.json = true;
      i += 1;
      continue;
    }

    if (token === "--base" || token.startsWith("--base=")) {
      let val;
      if (token.startsWith("--base=")) {
        val = token.slice("--base=".length);
      } else {
        val = tokens[i + 1];
        i += 1;
      }
      if (val === undefined || val === "") {
        throw new Error("Missing value for --base");
      }
      options.base = val;
      i += 1;
      continue;
    }

    if (token === "--plan" || token.startsWith("--plan=")) {
      let val;
      if (token.startsWith("--plan=")) {
        val = token.slice("--plan=".length);
      } else {
        val = tokens[i + 1];
        i += 1;
      }
      if (val === undefined || val === "") {
        throw new Error("Missing value for --plan");
      }
      options.plan = val;
      i += 1;
      continue;
    }

    throw new Error(`Unsupported option: ${token}. Supported options: ${ADVERSARIAL_REVIEW_SUPPORTED_HINT}`);
  }

  if (options.base && options.plan) {
    throw new Error("Cannot combine --base and --plan (they are mutually exclusive).");
  }

  if (options.wait && options.background) {
    throw new Error("Cannot combine --wait and --background (they are mutually exclusive).");
  }

  const focus = focusTokens.join(" ").trim();
  return { options, focus };
}

const SUPPORTED_OPTIONS_HINT = "--read-only, --full, --model <value>, --effort <value>, --json";

export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const supportedHint = config.supportedHint ?? SUPPORTED_OPTIONS_HINT;
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineVal] = token.slice(2).split("=", 2);

      if (booleanOptions.has(rawKey)) {
        options[rawKey] = inlineVal === undefined ? true : inlineVal !== "false";
        continue;
      }

      if (valueOptions.has(rawKey)) {
        const val = inlineVal ?? argv[i + 1];
        if (val === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[rawKey] = val;
        if (inlineVal === undefined) {
          i += 1;
        }
        continue;
      }

      throw new Error(`Unsupported option: --${rawKey}. Supported options: ${supportedHint}`);
    }

    const shortKey = token.slice(1);

    if (booleanOptions.has(shortKey)) {
      options[shortKey] = true;
      continue;
    }

    if (valueOptions.has(shortKey)) {
      const val = argv[i + 1];
      if (val === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[shortKey] = val;
      i += 1;
      continue;
    }

    throw new Error(`Unsupported option: -${shortKey}. Supported options: ${supportedHint}`);
  }

  return { options, positionals };
}
