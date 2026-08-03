/**
 * Recipe loading.
 *
 * Supports YAML, JSON, and JavaScript/ESM recipes. YAML is the default because
 * it reads well and needs no toolchain; JavaScript is there for when you need
 * real logic — computed URLs, custom transforms, lifecycle hooks.
 *
 * `${ENV_VAR}` placeholders are substituted from the environment (and from a
 * `.env` file next to the recipe, if present), so credentials and proxy lists
 * never have to be committed alongside the recipe.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

import { ConfigError } from '../utils/errors.js';
import { normalizeConfig } from './schema.js';

/**
 * Replace `${VAR}` and `${VAR:-default}` with environment values.
 * Applied to string leaves only, so structure is never affected.
 */
export function interpolateEnv(text, env = process.env, { strict = false } = {}) {
  const missing = [];
  const result = text.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (match, name, fallback) => {
    const value = env[name];
    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return match;
  });

  if (strict && missing.length) {
    throw new ConfigError(
      `The recipe references undefined environment variable(s): ${[...new Set(missing)].join(', ')}.\n` +
      '  Set them in your shell, in a .env file next to the recipe, or give a default with ${VAR:-fallback}.',
    );
  }
  return result;
}

/** Minimal `.env` reader — enough for `KEY=value` and `KEY="quoted value"`. */
export async function loadDotEnv(dir) {
  const file = path.join(dir, '.env');
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return {};
  }

  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/**
 * Load a recipe file and return a validated config.
 *
 * @param {string} filePath
 * @param {object} [options]
 * @param {string[]} [options.presets]
 * @param {object}  [options.overrides]
 * @returns {Promise<{config:object, warnings:string[], hooks:object, source:string}>}
 */
export async function loadRecipe(filePath, options = {}) {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).toLowerCase();
  const dir = path.dirname(resolved);

  let exists = true;
  try {
    await fs.access(resolved);
  } catch {
    exists = false;
  }
  if (!exists) {
    throw new ConfigError(
      `Recipe not found: ${resolved}\n` +
      "  Create one with `harvest init <name>`, or check the path.",
    );
  }

  const dotEnv = await loadDotEnv(dir);
  const env = { ...dotEnv, ...process.env };

  let raw;
  let hooks = {};

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    let module;
    try {
      module = await import(pathToFileURL(resolved).href);
    } catch (error) {
      throw new ConfigError(`Failed to load JavaScript recipe ${resolved}: ${error.message}`, { cause: error });
    }
    raw = module.default ?? module.recipe ?? module.config;
    if (typeof raw === 'function') raw = await raw({ env });
    if (!raw) {
      throw new ConfigError(
        `${resolved} does not export a recipe.\n` +
        '  Add `export default { start_urls: [...], extract: {...} }`.',
      );
    }
    // Hooks can only come from a JS recipe — they're functions.
    hooks = raw.hooks ?? module.hooks ?? {};
  } else {
    const text = await fs.readFile(resolved, 'utf8');
    const interpolated = interpolateEnv(text, env);

    if (ext === '.json') {
      try {
        raw = JSON.parse(interpolated);
      } catch (error) {
        throw new ConfigError(`Invalid JSON in ${resolved}: ${error.message}`, { cause: error });
      }
    } else if (ext === '.yaml' || ext === '.yml' || ext === '') {
      try {
        raw = YAML.parse(interpolated, { merge: true });
      } catch (error) {
        // YAML errors carry line/column — surface them, they're the useful part.
        const where = error.linePos?.[0] ? ` (line ${error.linePos[0].line}, column ${error.linePos[0].col})` : '';
        throw new ConfigError(`Invalid YAML in ${resolved}${where}: ${error.message}`, { cause: error });
      }
    } else {
      throw new ConfigError(
        `Unsupported recipe format '${ext}'. Use .yaml, .yml, .json, .js or .mjs.`,
      );
    }
  }

  if (raw == null) {
    throw new ConfigError(`${resolved} is empty.`);
  }

  const { config, warnings } = normalizeConfig(raw, { ...options, strict: true });

  // Resolve relative paths against the recipe's directory, not the cwd — a
  // recipe should behave the same wherever you run it from.
  resolveRelativePaths(config, dir);

  config.name ||= path.basename(resolved, ext);
  return { config, warnings, hooks, source: resolved, dir };
}

function resolveRelativePaths(config, dir) {
  const resolve = (p) => (p && !path.isAbsolute(p) ? path.resolve(dir, p) : p);

  if (config.proxy?.file) config.proxy.file = resolve(config.proxy.file);
  if (config.cache?.dir) config.cache.dir = resolve(config.cache.dir);
  if (config.resume?.statePath) config.resume.statePath = resolve(config.resume.statePath);
  if (config.dedupe?.persistPath) config.dedupe.persistPath = resolve(config.dedupe.persistPath);
  if (config.report) config.report = resolve(config.report);

  config.output = (config.output ?? []).map((spec) => {
    if (typeof spec === 'string') return spec === '-' ? spec : resolve(spec);
    if (spec?.path && spec.path !== '-') return { ...spec, path: resolve(spec.path) };
    return spec;
  });
}

/**
 * Build a config from a plain object (the programmatic entry point).
 * @returns {{config:object, warnings:string[], hooks:object}}
 */
export function defineRecipe(recipe, options = {}) {
  const { config, warnings } = normalizeConfig(recipe, options);
  config.name ||= 'harvest';
  return { config, warnings, hooks: recipe.hooks ?? {}, source: '<inline>' };
}

/** Serialise a config back to YAML — used by `harvest init` and `--print-config`. */
export function toYaml(config) {
  const clean = JSON.parse(JSON.stringify(config, (key, value) => {
    if (key.endsWith('Effective')) return undefined;
    return value;
  }));
  return YAML.stringify(clean, { lineWidth: 100 });
}
