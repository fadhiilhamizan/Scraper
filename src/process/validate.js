/**
 * Record-level schema validation.
 *
 * Field-level `type:` and `required:` in the extractor cover single values;
 * this covers the record as a whole — cross-field rules, ranges, enums, and
 * what to do with a record that fails.
 *
 * The `onInvalid` policy matters more than the rules themselves. Silently
 * dropping bad records hides that a site changed; `quarantine` (the default)
 * keeps them in a separate file so you can see *what* broke.
 */

/**
 * @typedef {object} FieldRule
 * @property {boolean} [required]
 * @property {string}  [type]        string|number|integer|boolean|array|object|url|email|date
 * @property {number}  [min]         Numeric minimum (or array/string length minimum via minLength).
 * @property {number}  [max]
 * @property {number}  [minLength]
 * @property {number}  [maxLength]
 * @property {string}  [pattern]     RegExp source the value must match.
 * @property {any[]}   [enum]
 * @property {(value:any, record:object) => boolean|string} [custom]
 */

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v != null && typeof v === 'object' && !Array.isArray(v),
  url: (v) => {
    if (typeof v !== 'string') return false;
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  },
  email: (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  date: (v) => Number.isFinite(Date.parse(String(v))),
  any: () => true,
};

const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

export class Validator {
  /**
   * @param {object} [options]
   * @param {Record<string, FieldRule>} [options.schema]
   * @param {'warn'|'drop'|'quarantine'|'error'} [options.onInvalid='quarantine']
   * @param {boolean} [options.strict=false]  Reject unknown fields.
   * @param {number}  [options.minFilledFields=0] Reject near-empty records —
   *        the usual symptom of a selector that stopped matching.
   */
  constructor(options = {}) {
    this.schema = options.schema ?? null;
    this.onInvalid = options.onInvalid ?? 'quarantine';
    this.strict = options.strict === true;
    this.minFilledFields = options.minFilledFields ?? 0;
    this.enabled = options.enabled !== false && (!!this.schema || this.minFilledFields > 0);

    this.stats = { checked: 0, valid: 0, invalid: 0, quarantined: 0, dropped: 0 };
  }

  /**
   * @param {object} record
   * @returns {{valid:boolean, issues:{field:string, rule:string, message:string}[]}}
   */
  validate(record) {
    const issues = [];
    if (!this.enabled) return { valid: true, issues };

    this.stats.checked += 1;

    if (record == null || typeof record !== 'object') {
      issues.push({ field: '_record', rule: 'type', message: 'record is not an object' });
      this.stats.invalid += 1;
      return { valid: false, issues };
    }

    const filled = Object.values(record).filter((v) => !isEmpty(v)).length;
    if (this.minFilledFields > 0 && filled < this.minFilledFields) {
      issues.push({
        field: '_record',
        rule: 'minFilledFields',
        message: `only ${filled} field(s) populated, expected at least ${this.minFilledFields}`,
      });
    }

    if (this.schema) {
      for (const [field, rawRule] of Object.entries(this.schema)) {
        const rule = typeof rawRule === 'string' ? { type: rawRule } : rawRule;
        const value = record[field];
        issues.push(...checkField(field, value, rule, record));
      }

      if (this.strict) {
        for (const key of Object.keys(record)) {
          if (!(key in this.schema) && !key.startsWith('_')) {
            issues.push({ field: key, rule: 'strict', message: 'unexpected field' });
          }
        }
      }
    }

    const valid = issues.length === 0;
    if (valid) this.stats.valid += 1;
    else this.stats.invalid += 1;
    return { valid, issues };
  }

  /**
   * Validate and apply the `onInvalid` policy.
   * @returns {{action:'keep'|'drop'|'quarantine', record:object, issues:any[]}}
   */
  process(record) {
    const { valid, issues } = this.validate(record);
    if (valid) return { action: 'keep', record, issues: [] };

    switch (this.onInvalid) {
      case 'error': {
        const error = new Error(
          `Record failed validation: ${issues.map((i) => `${i.field} (${i.message})`).join('; ')}`,
        );
        error.issues = issues;
        throw error;
      }
      case 'drop':
        this.stats.dropped += 1;
        return { action: 'drop', record, issues };
      case 'warn':
        return { action: 'keep', record, issues };
      case 'quarantine':
      default:
        this.stats.quarantined += 1;
        return { action: 'quarantine', record, issues };
    }
  }
}

function checkField(field, value, rule, record) {
  const issues = [];
  const add = (r, message) => issues.push({ field, rule: r, message });

  if (isEmpty(value)) {
    if (rule.required) add('required', 'is required but missing or empty');
    return issues; // No point checking anything else on an absent value.
  }

  if (rule.type) {
    const check = TYPE_CHECKS[String(rule.type).toLowerCase()];
    if (check && !check(value)) {
      add('type', `expected ${rule.type}, got ${Array.isArray(value) ? 'array' : typeof value}`);
      return issues; // Later rules assume the type held.
    }
  }

  if (typeof value === 'number') {
    if (rule.min != null && value < rule.min) add('min', `${value} is below the minimum ${rule.min}`);
    if (rule.max != null && value > rule.max) add('max', `${value} is above the maximum ${rule.max}`);
  }

  const length = typeof value === 'string' || Array.isArray(value) ? value.length : null;
  if (length != null) {
    if (rule.minLength != null && length < rule.minLength) {
      add('minLength', `length ${length} is below the minimum ${rule.minLength}`);
    }
    if (rule.maxLength != null && length > rule.maxLength) {
      add('maxLength', `length ${length} exceeds the maximum ${rule.maxLength}`);
    }
  }

  if (rule.pattern && typeof value === 'string') {
    try {
      if (!new RegExp(rule.pattern).test(value)) {
        add('pattern', `does not match ${rule.pattern}`);
      }
    } catch {
      add('pattern', `invalid pattern ${rule.pattern}`);
    }
  }

  if (Array.isArray(rule.enum) && !rule.enum.includes(value)) {
    add('enum', `must be one of ${rule.enum.join(', ')}`);
  }

  if (typeof rule.custom === 'function') {
    const result = rule.custom(value, record);
    if (result === false) add('custom', 'failed the custom check');
    else if (typeof result === 'string') add('custom', result);
  }

  return issues;
}

export function createValidator(options) {
  return new Validator(options);
}
