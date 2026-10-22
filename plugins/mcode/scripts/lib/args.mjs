export const DELEGATE_OPTION_CONFIG = {
  valueOptions: ["model", "effort"],
  booleanOptions: ["read-only", "full", "json"],
  supportedHint: "--read-only, --full, --model <value>, --effort <value>, --json"
};

export const SETUP_OPTION_CONFIG = {
  valueOptions: [],
  booleanOptions: ["json"],
  supportedHint: "--json"
};

export const STATUS_OPTION_CONFIG = {
  valueOptions: [],
  booleanOptions: ["all", "json"],
  supportedHint: "--all, --json"
};

export const RESULT_OPTION_CONFIG = {
  valueOptions: [],
  booleanOptions: ["all", "json"],
  supportedHint: "--all, --json"
};

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
