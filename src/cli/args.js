/**
 * A small, dependency-free argument parser.
 *
 * Handles the forms people actually type: `--flag`, `--flag=value`,
 * `--flag value`, `-abc` bundles, `--no-flag`, repeated flags collecting into
 * an array, and `--` to stop parsing.
 */

/**
 * A flag typed `'optional'` may be given bare (`--render`) or with a value
 * (`--render auto`). To keep that unambiguous it only consumes the next token
 * when that token is in the flag's `optionalValues` list — so
 * `harvest test r.yaml --render https://x` still treats the URL as positional.
 *
 * @param {string[]} argv
 * @param {object} spec
 * @param {Record<string,'boolean'|'string'|'number'|'array'|'optional'>} [spec.flags]
 * @param {Record<string,string>} [spec.aliases]  short -> long
 * @param {Record<string,string[]>} [spec.optionalValues]
 * @returns {{command:string|null, positional:string[], flags:object, rest:string[], unknown:string[]}}
 */
export function parseArgs(argv, spec = {}) {
  const types = spec.flags ?? {};
  const aliases = spec.aliases ?? {};
  const optionalValues = spec.optionalValues ?? {};

  const flags = {};
  const positional = [];
  const unknown = [];
  const rest = [];

  const canonical = (name) => aliases[name] ?? name;

  const setFlag = (rawName, value) => {
    const name = canonical(rawName);
    const type = types[name];

    if (type === undefined) {
      unknown.push(`--${rawName}`);
      return;
    }
    if (type === 'array') {
      flags[name] ??= [];
      flags[name].push(value);
      return;
    }
    if (type === 'number') {
      const n = Number(value);
      flags[name] = Number.isFinite(n) ? n : value;
      return;
    }
    flags[name] = value;
  };

  let i = 0;
  let stopped = false;

  while (i < argv.length) {
    const token = argv[i];

    if (stopped) {
      rest.push(token);
      i += 1;
      continue;
    }

    if (token === '--') {
      stopped = true;
      i += 1;
      continue;
    }

    if (token.startsWith('--')) {
      let body = token.slice(2);
      let inlineValue;
      const eq = body.indexOf('=');
      if (eq !== -1) {
        inlineValue = body.slice(eq + 1);
        body = body.slice(0, eq);
      }

      // `--no-foo` turns a boolean off.
      if (body.startsWith('no-') && types[canonical(body.slice(3))] === 'boolean') {
        flags[canonical(body.slice(3))] = false;
        i += 1;
        continue;
      }

      const name = canonical(body);
      const type = types[name];

      if (type === undefined) {
        unknown.push(`--${body}`);
        i += 1;
        if (inlineValue === undefined && argv[i] && !argv[i].startsWith('-')) i += 1;
        continue;
      }

      if (type === 'boolean') {
        flags[name] = inlineValue === undefined ? true : inlineValue !== 'false';
        i += 1;
        continue;
      }

      if (inlineValue !== undefined) {
        if (type === 'optional') flags[name] = inlineValue;
        else setFlag(body, inlineValue);
        i += 1;
        continue;
      }

      if (type === 'optional') {
        const next = argv[i + 1];
        const allowed = optionalValues[name] ?? [];
        if (next !== undefined && allowed.includes(next)) {
          flags[name] = next;
          i += 2;
        } else {
          flags[name] = true;
          i += 1;
        }
        continue;
      }

      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-' && Number.isNaN(Number(next)))) {
        throw new Error(`--${body} needs a value`);
      }
      setFlag(body, next);
      i += 2;
      continue;
    }

    if (token.startsWith('-') && token.length > 1 && token !== '-') {
      const letters = token.slice(1);
      let consumedValue = false;

      for (let k = 0; k < letters.length; k += 1) {
        const letter = letters[k];
        const name = canonical(letter);
        const type = types[name];

        if (type === undefined) {
          unknown.push(`-${letter}`);
          continue;
        }
        if (type === 'boolean') {
          flags[name] = true;
          continue;
        }
        // A value-taking short flag consumes the remainder, or the next token.
        const inline = letters.slice(k + 1);
        if (inline) {
          setFlag(letter, inline);
          k = letters.length;
        } else {
          const next = argv[i + 1];
          if (next === undefined) throw new Error(`-${letter} needs a value`);
          setFlag(letter, next);
          consumedValue = true;
        }
      }
      i += consumedValue ? 2 : 1;
      continue;
    }

    positional.push(token);
    i += 1;
  }

  // Apply declared defaults for booleans that were never mentioned.
  for (const [name, type] of Object.entries(types)) {
    if (type === 'array' && flags[name] === undefined) flags[name] = [];
  }

  return {
    command: positional[0] ?? null,
    positional: positional.slice(1),
    flags,
    rest,
    unknown,
  };
}

/** Format a two-column option list for help text. */
export function formatOptions(entries, indent = '  ') {
  const width = Math.max(...entries.map(([left]) => left.length)) + 2;
  return entries
    .map(([left, right]) => `${indent}${left.padEnd(width)}${right}`)
    .join('\n');
}
