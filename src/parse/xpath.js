/**
 * An XPath 1.0 engine for `domhandler` trees (the DOM cheerio builds).
 *
 * Why not a library? The published options either need a real DOM (jsdom —
 * heavy) or an XML-strict parser that chokes on real-world HTML. Since we
 * already have a lenient HTML tree from cheerio, evaluating XPath directly
 * against it is both faster and far more forgiving.
 *
 * Supported: all thirteen axes, node tests (`name`, `*`, `text()`, `node()`,
 * `comment()`, `processing-instruction()`), predicates with full boolean and
 * comparison semantics, unions, arithmetic, and the XPath 1.0 core function
 * library. Not supported: namespaces beyond literal prefix matching, variable
 * references, and `id()`/`lang()`.
 *
 * @example
 *   evaluate('//div[@class="price"]/text()', root)          // -> node-set
 *   evaluateToStrings('//a/@href', root)                    // -> string[]
 *   evaluateToString('normalize-space(//h1)', root)         // -> string
 */

/* ────────────────────────────── node adapters ───────────────────────────── */

const ELEMENT_TYPES = new Set(['tag', 'script', 'style']);

export const isElement = (n) => !!n && ELEMENT_TYPES.has(n.type);
export const isText = (n) => !!n && (n.type === 'text' || n.type === 'cdata');
export const isComment = (n) => !!n && n.type === 'comment';
export const isRoot = (n) => !!n && n.type === 'root';
export const isAttribute = (n) => !!n && n.type === 'attribute';

const childrenOf = (n) => (isElement(n) || isRoot(n) ? n.children ?? [] : []);
const parentOf = (n) => (isAttribute(n) ? n.ownerElement : n?.parent ?? null);

function nodeName(node) {
  if (isElement(node)) return node.name;
  if (isAttribute(node)) return node.name;
  return '';
}

function localName(node) {
  const name = nodeName(node);
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/** XPath string-value of a node (spec §5). */
export function stringValue(node) {
  if (node == null) return '';
  if (isAttribute(node)) return node.value ?? '';
  if (isText(node)) return node.data ?? '';
  if (isComment(node)) return node.data ?? '';
  if (isElement(node) || isRoot(node)) {
    // Iterative walk: deeply nested documents would overflow the call stack.
    let out = '';
    const stack = [...childrenOf(node)].reverse();
    while (stack.length) {
      const current = stack.pop();
      if (isText(current)) out += current.data ?? '';
      else if (isElement(current)) {
        const kids = childrenOf(current);
        for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
      }
    }
    return out;
  }
  return '';
}

/* ─────────────────────────── document ordering ──────────────────────────── */

const ORDER_CACHE = new WeakMap();

/** Assign a monotonically increasing index to every node, once per document. */
function indexDocument(root) {
  let cached = ORDER_CACHE.get(root);
  if (cached) return cached;
  cached = new WeakMap();
  let counter = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    cached.set(node, counter++);
    const kids = childrenOf(node);
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  ORDER_CACHE.set(root, cached);
  return cached;
}

function documentRoot(node) {
  let current = node;
  while (parentOf(current)) current = parentOf(current);
  return current;
}

/** Sort a node-set into document order and remove duplicates. */
function toDocumentOrder(nodes) {
  if (nodes.length < 2) return nodes;
  const root = documentRoot(isAttribute(nodes[0]) ? nodes[0].ownerElement : nodes[0]);
  const order = indexDocument(root);
  const seen = new Set();
  const unique = [];
  for (const n of nodes) {
    const key = isAttribute(n) ? `${order.get(n.ownerElement)}@${n.name}` : order.get(n);
    if (key === undefined || seen.has(key)) {
      if (key === undefined && !seen.has(n)) { seen.add(n); unique.push(n); }
      continue;
    }
    seen.add(key);
    unique.push(n);
  }
  return unique.sort((a, b) => {
    const ai = order.get(isAttribute(a) ? a.ownerElement : a) ?? 0;
    const bi = order.get(isAttribute(b) ? b.ownerElement : b) ?? 0;
    if (ai !== bi) return ai - bi;
    if (isAttribute(a) && isAttribute(b)) return a.name < b.name ? -1 : 1;
    return isAttribute(a) ? 1 : -1;
  });
}

/* ──────────────────────────────── tokenizer ─────────────────────────────── */

const OPERATOR_NAMES = new Set(['and', 'or', 'div', 'mod']);
const AXIS_NAMES = new Set([
  'ancestor', 'ancestor-or-self', 'attribute', 'child', 'descendant',
  'descendant-or-self', 'following', 'following-sibling', 'namespace',
  'parent', 'preceding', 'preceding-sibling', 'self',
]);
const NODE_TYPES = new Set(['node', 'text', 'comment', 'processing-instruction']);

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_\-.]/;

/** Operator tokens, for the disambiguation rule below. */
const OPERATORS = new Set([
  '/', '//', '|', '+', '-', '=', '!=', '<', '<=', '>', '>=', '*',
  'and', 'or', 'div', 'mod', '::', '@', '(', '[', ',',
]);

/**
 * XPath 1.0 §3.7 lexical disambiguation: `*` is multiplication, and a bare
 * name is an operator name (`and`/`or`/`div`/`mod`), only when the *preceding*
 * token is not `@`, `::`, `(`, `[`, `,` or another operator. Without this rule
 * `//a[b div c]` and `//*` cannot both parse.
 */
function precedingAllowsOperator(prev) {
  if (!prev) return false;
  if (prev.type === 'op' && OPERATORS.has(prev.value)) return false;
  return true;
}

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  const n = expr.length;

  const prev = () => tokens[tokens.length - 1];

  while (i < n) {
    const ch = expr[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue; }

    // String literals.
    if (ch === '"' || ch === "'") {
      const end = expr.indexOf(ch, i + 1);
      if (end === -1) throw new SyntaxError(`Unterminated string literal in XPath: ${expr}`);
      tokens.push({ type: 'string', value: expr.slice(i + 1, end) });
      i = end + 1;
      continue;
    }

    // Numbers (`.5` included).
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(expr[i + 1] ?? ''))) {
      let j = i;
      while (j < n && /[0-9.]/.test(expr[j])) j += 1;
      tokens.push({ type: 'number', value: Number.parseFloat(expr.slice(i, j)) });
      i = j;
      continue;
    }

    // Multi-character operators.
    const two = expr.slice(i, i + 2);
    if (two === '//' || two === '::' || two === '..' || two === '!=' || two === '<=' || two === '>=') {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }

    if ('/()[]@,|+-=<>.'.includes(ch)) {
      // Disambiguate `*`: handled below. `.` alone is the self step.
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }

    if (ch === '*') {
      tokens.push({ type: precedingAllowsOperator(prev()) ? 'op' : 'wildcard', value: '*' });
      i += 1;
      continue;
    }

    if (NAME_START.test(ch)) {
      let j = i;
      while (j < n && NAME_CHAR.test(expr[j])) j += 1;
      // Allow a single `:` for QNames / axes, but not `::`.
      if (expr[j] === ':' && expr[j + 1] !== ':' && NAME_START.test(expr[j + 1] ?? '')) {
        j += 1;
        while (j < n && NAME_CHAR.test(expr[j])) j += 1;
      }
      const value = expr.slice(i, j);
      if (OPERATOR_NAMES.has(value) && precedingAllowsOperator(prev())) {
        tokens.push({ type: 'op', value });
      } else {
        tokens.push({ type: 'name', value });
      }
      i = j;
      continue;
    }

    throw new SyntaxError(`Unexpected character '${ch}' at position ${i} in XPath: ${expr}`);
  }
  return tokens;
}

/* ──────────────────────────────── parser ────────────────────────────────── */

class Parser {
  constructor(tokens, source) {
    this.tokens = tokens;
    this.pos = 0;
    this.source = source;
  }

  peek(offset = 0) { return this.tokens[this.pos + offset]; }
  next() { return this.tokens[this.pos++]; }
  atEnd() { return this.pos >= this.tokens.length; }

  isOp(value, offset = 0) {
    const t = this.peek(offset);
    return t && t.type === 'op' && t.value === value;
  }

  expectOp(value) {
    if (!this.isOp(value)) {
      throw new SyntaxError(`Expected '${value}' in XPath: ${this.source}`);
    }
    return this.next();
  }

  parse() {
    const expr = this.parseExpr();
    if (!this.atEnd()) {
      throw new SyntaxError(`Unexpected trailing input in XPath: ${this.source}`);
    }
    return expr;
  }

  parseExpr() { return this.parseOr(); }

  parseOr() {
    let left = this.parseAnd();
    while (this.isOp('or')) {
      this.next();
      left = { kind: 'binary', op: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseEquality();
    while (this.isOp('and')) {
      this.next();
      left = { kind: 'binary', op: 'and', left, right: this.parseEquality() };
    }
    return left;
  }

  parseEquality() {
    let left = this.parseRelational();
    while (this.isOp('=') || this.isOp('!=')) {
      const op = this.next().value;
      left = { kind: 'binary', op, left, right: this.parseRelational() };
    }
    return left;
  }

  parseRelational() {
    let left = this.parseAdditive();
    while (this.isOp('<') || this.isOp('>') || this.isOp('<=') || this.isOp('>=')) {
      const op = this.next().value;
      left = { kind: 'binary', op, left, right: this.parseAdditive() };
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().value;
      left = { kind: 'binary', op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.isOp('*') || this.isOp('div') || this.isOp('mod')) {
      const op = this.next().value;
      left = { kind: 'binary', op, left, right: this.parseUnary() };
    }
    return left;
  }

  parseUnary() {
    if (this.isOp('-')) {
      this.next();
      return { kind: 'unary', op: '-', operand: this.parseUnary() };
    }
    return this.parseUnion();
  }

  parseUnion() {
    let left = this.parsePath();
    while (this.isOp('|')) {
      this.next();
      left = { kind: 'union', left, right: this.parsePath() };
    }
    return left;
  }

  parsePath() {
    // Absolute path.
    if (this.isOp('/') || this.isOp('//')) {
      const abbreviated = this.peek().value === '//';
      this.next();
      const steps = [];
      if (abbreviated) {
        steps.push({ axis: 'descendant-or-self', test: { type: 'node' }, predicates: [] });
      }
      if (this.#startsStep()) steps.push(...this.parseRelativePath());
      return { kind: 'path', absolute: true, steps };
    }

    // Filter expression (primary + predicates), possibly followed by a path.
    if (this.#startsPrimary()) {
      let expr = this.parseFilter();
      if (this.isOp('/') || this.isOp('//')) {
        const steps = [];
        while (this.isOp('/') || this.isOp('//')) {
          const abbreviated = this.next().value === '//';
          if (abbreviated) steps.push({ axis: 'descendant-or-self', test: { type: 'node' }, predicates: [] });
          steps.push(this.parseStep());
        }
        expr = { kind: 'path', absolute: false, base: expr, steps };
      }
      return expr;
    }

    return { kind: 'path', absolute: false, steps: this.parseRelativePath() };
  }

  #startsPrimary() {
    const t = this.peek();
    if (!t) return false;
    if (t.type === 'string' || t.type === 'number') return true;
    if (t.type === 'op' && t.value === '(') return true;
    // A name followed by `(` is a function call unless it's a node type test.
    if (t.type === 'name' && this.isOp('(', 1) && !NODE_TYPES.has(t.value)) return true;
    return false;
  }

  #startsStep() {
    const t = this.peek();
    if (!t) return false;
    if (t.type === 'name' || t.type === 'wildcard') return true;
    if (t.type === 'op' && ['@', '.', '..'].includes(t.value)) return true;
    return false;
  }

  parseRelativePath() {
    const steps = [this.parseStep()];
    while (this.isOp('/') || this.isOp('//')) {
      const abbreviated = this.next().value === '//';
      if (abbreviated) {
        steps.push({ axis: 'descendant-or-self', test: { type: 'node' }, predicates: [] });
      }
      steps.push(this.parseStep());
    }
    return steps;
  }

  parseStep() {
    if (this.isOp('.')) {
      this.next();
      return { axis: 'self', test: { type: 'node' }, predicates: [] };
    }
    if (this.isOp('..')) {
      this.next();
      return { axis: 'parent', test: { type: 'node' }, predicates: [] };
    }

    let axis = 'child';
    if (this.isOp('@')) {
      this.next();
      axis = 'attribute';
    } else if (this.peek()?.type === 'name' && this.isOp('::', 1)) {
      const name = this.next().value;
      if (!AXIS_NAMES.has(name)) throw new SyntaxError(`Unknown XPath axis '${name}'`);
      this.next(); // consume '::'
      axis = name;
    }

    const test = this.parseNodeTest();
    const predicates = [];
    while (this.isOp('[')) {
      this.next();
      predicates.push(this.parseExpr());
      this.expectOp(']');
    }
    return { axis, test, predicates };
  }

  parseNodeTest() {
    const t = this.peek();
    if (!t) throw new SyntaxError(`Expected a node test in XPath: ${this.source}`);

    if (t.type === 'wildcard') {
      this.next();
      return { type: 'wildcard' };
    }
    if (t.type === 'name') {
      const name = this.next().value;
      if (NODE_TYPES.has(name) && this.isOp('(')) {
        this.next();
        let literal = null;
        if (this.peek()?.type === 'string') literal = this.next().value;
        this.expectOp(')');
        return { type: name === 'node' ? 'node' : name, literal };
      }
      // `prefix:*`
      if (name.endsWith(':') && this.peek()?.type === 'wildcard') {
        this.next();
        return { type: 'nsWildcard', prefix: name.slice(0, -1) };
      }
      return { type: 'name', name };
    }
    throw new SyntaxError(`Invalid node test near '${t.value}' in XPath: ${this.source}`);
  }

  parseFilter() {
    let expr = this.parsePrimary();
    while (this.isOp('[')) {
      this.next();
      const predicate = this.parseExpr();
      this.expectOp(']');
      expr = { kind: 'filter', expr, predicate };
    }
    return expr;
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'string') { this.next(); return { kind: 'literal', value: t.value }; }
    if (t.type === 'number') { this.next(); return { kind: 'number', value: t.value }; }
    if (t.type === 'op' && t.value === '(') {
      this.next();
      const expr = this.parseExpr();
      this.expectOp(')');
      return expr;
    }
    if (t.type === 'name' && this.isOp('(', 1)) {
      const name = this.next().value;
      this.next(); // '('
      const args = [];
      if (!this.isOp(')')) {
        args.push(this.parseExpr());
        while (this.isOp(',')) {
          this.next();
          args.push(this.parseExpr());
        }
      }
      this.expectOp(')');
      return { kind: 'call', name, args };
    }
    throw new SyntaxError(`Unexpected token '${t.value}' in XPath: ${this.source}`);
  }
}

/* ─────────────────────────────── evaluator ──────────────────────────────── */

function attributeNodes(element) {
  if (!isElement(element)) return [];
  return Object.entries(element.attribs ?? {}).map(([name, value]) => ({
    type: 'attribute',
    name,
    value,
    ownerElement: element,
  }));
}

function descendants(node, out = []) {
  for (const child of childrenOf(node)) {
    out.push(child);
    descendants(child, out);
  }
  return out;
}

function ancestors(node) {
  const out = [];
  let current = parentOf(node);
  while (current) {
    out.push(current);
    current = parentOf(current);
  }
  return out;
}

function siblings(node, direction) {
  const parent = parentOf(node);
  if (!parent) return [];
  const kids = childrenOf(parent);
  const index = kids.indexOf(node);
  if (index === -1) return [];
  return direction === 'following' ? kids.slice(index + 1) : kids.slice(0, index).reverse();
}

function followingNodes(node) {
  const out = [];
  let current = node;
  while (current) {
    for (const sib of siblings(current, 'following')) {
      out.push(sib);
      descendants(sib, out);
    }
    current = parentOf(current);
  }
  return out;
}

function precedingNodes(node) {
  const ancestorSet = new Set(ancestors(node));
  const root = documentRoot(node);
  const all = descendants(root);
  const order = indexDocument(root);
  const self = order.get(node) ?? 0;
  return all.filter((n) => (order.get(n) ?? 0) < self && !ancestorSet.has(n) && n !== node).reverse();
}

function axisNodes(node, axis) {
  switch (axis) {
    case 'child': return childrenOf(node);
    case 'descendant': return descendants(node);
    case 'descendant-or-self': return [node, ...descendants(node)];
    case 'parent': { const p = parentOf(node); return p ? [p] : []; }
    case 'ancestor': return ancestors(node);
    case 'ancestor-or-self': return [node, ...ancestors(node)];
    case 'following-sibling': return siblings(node, 'following');
    case 'preceding-sibling': return siblings(node, 'preceding');
    case 'following': return followingNodes(node);
    case 'preceding': return precedingNodes(node);
    case 'self': return [node];
    case 'attribute': return attributeNodes(node);
    case 'namespace': return [];
    default: return [];
  }
}

function matchesTest(node, test, axis) {
  switch (test.type) {
    case 'node':
      return true;
    case 'text':
      return isText(node);
    case 'comment':
      return isComment(node);
    case 'processing-instruction':
      return node.type === 'directive';
    case 'wildcard':
      // On the attribute axis `*` means any attribute; elsewhere, any element.
      return axis === 'attribute' ? isAttribute(node) : isElement(node);
    case 'nsWildcard':
      return isElement(node) && nodeName(node).startsWith(`${test.prefix}:`);
    case 'name': {
      if (axis === 'attribute') {
        return isAttribute(node) && (node.name === test.name || localName(node) === test.name);
      }
      if (!isElement(node)) return false;
      // HTML tag names are case-insensitive; cheerio lowercases them already.
      const name = nodeName(node);
      return name === test.name || name === test.name.toLowerCase() || localName(node) === test.name;
    }
    default:
      return false;
  }
}

/* Type coercion, per XPath 1.0 §3.  */

const isNodeSet = (v) => Array.isArray(v);

export function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (isNodeSet(value)) return toNumber(value.length ? stringValue(value[0]) : '');
  const trimmed = String(value).trim();
  if (trimmed === '') return NaN;
  const n = Number(trimmed);
  return Number.isNaN(n) ? NaN : n;
}

export function toStringValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    return String(value);
  }
  if (isNodeSet(value)) return value.length ? stringValue(value[0]) : '';
  return String(value ?? '');
}

export function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  if (isNodeSet(value)) return value.length > 0;
  return !!value;
}

function compare(op, left, right) {
  // Node-set comparisons are existential: true if *any* pair satisfies it.
  if (isNodeSet(left) || isNodeSet(right)) {
    const leftValues = isNodeSet(left) ? left.map(stringValue) : [left];
    const rightValues = isNodeSet(right) ? right.map(stringValue) : [right];
    const numeric = op !== '=' && op !== '!=';
    for (const l of leftValues) {
      for (const r of rightValues) {
        if (numeric) {
          if (compareScalars(op, toNumber(l), toNumber(r))) return true;
        } else if (typeof left === 'number' || typeof right === 'number') {
          if (compareScalars(op, toNumber(l), toNumber(r))) return true;
        } else if (typeof left === 'boolean' || typeof right === 'boolean') {
          if (compareScalars(op, toBoolean(l), toBoolean(r))) return true;
        } else if (compareScalars(op, toStringValue(l), toStringValue(r))) {
          return true;
        }
      }
    }
    return false;
  }

  if (op === '=' || op === '!=') {
    if (typeof left === 'boolean' || typeof right === 'boolean') {
      return compareScalars(op, toBoolean(left), toBoolean(right));
    }
    if (typeof left === 'number' || typeof right === 'number') {
      return compareScalars(op, toNumber(left), toNumber(right));
    }
    return compareScalars(op, toStringValue(left), toStringValue(right));
  }
  return compareScalars(op, toNumber(left), toNumber(right));
}

function compareScalars(op, a, b) {
  switch (op) {
    case '=': return a === b;
    case '!=': return a !== b;
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
    default: return false;
  }
}

const FUNCTIONS = {
  // Node-set
  last: (ctx) => ctx.size,
  position: (ctx) => ctx.position,
  count: (_ctx, nodes) => (isNodeSet(nodes) ? nodes.length : 0),
  'local-name': (ctx, nodes) => {
    const node = isNodeSet(nodes) ? nodes[0] : ctx.node;
    return node ? localName(node) : '';
  },
  name: (ctx, nodes) => {
    const node = isNodeSet(nodes) ? nodes[0] : ctx.node;
    return node ? nodeName(node) : '';
  },
  'namespace-uri': () => '',

  // String
  string: (ctx, value) => (value === undefined ? stringValue(ctx.node) : toStringValue(value)),
  concat: (_ctx, ...args) => args.map(toStringValue).join(''),
  'starts-with': (_ctx, a, b) => toStringValue(a).startsWith(toStringValue(b)),
  'ends-with': (_ctx, a, b) => toStringValue(a).endsWith(toStringValue(b)), // XPath 2.0, widely expected
  contains: (_ctx, a, b) => toStringValue(a).includes(toStringValue(b)),
  'substring-before': (_ctx, a, b) => {
    const s = toStringValue(a);
    const idx = s.indexOf(toStringValue(b));
    return idx === -1 ? '' : s.slice(0, idx);
  },
  'substring-after': (_ctx, a, b) => {
    const s = toStringValue(a);
    const needle = toStringValue(b);
    const idx = s.indexOf(needle);
    return idx === -1 ? '' : s.slice(idx + needle.length);
  },
  substring: (_ctx, a, start, length) => {
    const s = toStringValue(a);
    // XPath substring() is 1-based and rounds its arguments.
    const from = Math.round(toNumber(start));
    if (Number.isNaN(from)) return '';
    const begin = Math.max(1, from);
    if (length === undefined) return s.slice(begin - 1);
    const len = Math.round(toNumber(length));
    if (Number.isNaN(len)) return '';
    const end = from + len;
    return s.slice(begin - 1, Math.max(0, end - 1));
  },
  'string-length': (ctx, value) =>
    (value === undefined ? stringValue(ctx.node) : toStringValue(value)).length,
  'normalize-space': (ctx, value) =>
    (value === undefined ? stringValue(ctx.node) : toStringValue(value)).replace(/\s+/g, ' ').trim(),
  translate: (_ctx, a, from, to) => {
    const s = toStringValue(a);
    const src = toStringValue(from);
    const dst = toStringValue(to);
    let out = '';
    for (const ch of s) {
      const idx = src.indexOf(ch);
      if (idx === -1) out += ch;
      else if (idx < dst.length) out += dst[idx];
    }
    return out;
  },
  'lower-case': (_ctx, a) => toStringValue(a).toLowerCase(),
  'upper-case': (_ctx, a) => toStringValue(a).toUpperCase(),
  matches: (_ctx, a, pattern, flags) => {
    try {
      return new RegExp(toStringValue(pattern), flags ? toStringValue(flags) : '').test(toStringValue(a));
    } catch {
      return false;
    }
  },

  // Boolean
  boolean: (_ctx, value) => toBoolean(value),
  not: (_ctx, value) => !toBoolean(value),
  true: () => true,
  false: () => false,

  // Number
  number: (ctx, value) => (value === undefined ? toNumber(stringValue(ctx.node)) : toNumber(value)),
  sum: (_ctx, nodes) => (isNodeSet(nodes) ? nodes.reduce((acc, n) => acc + toNumber(stringValue(n)), 0) : NaN),
  floor: (_ctx, value) => Math.floor(toNumber(value)),
  ceiling: (_ctx, value) => Math.ceil(toNumber(value)),
  round: (_ctx, value) => Math.round(toNumber(value)),
};

function evaluateNode(ast, ctx) {
  switch (ast.kind) {
    case 'literal': return ast.value;
    case 'number': return ast.value;

    case 'unary': return -toNumber(evaluateNode(ast.operand, ctx));

    case 'binary': {
      const { op } = ast;
      if (op === 'and') {
        return toBoolean(evaluateNode(ast.left, ctx)) && toBoolean(evaluateNode(ast.right, ctx));
      }
      if (op === 'or') {
        return toBoolean(evaluateNode(ast.left, ctx)) || toBoolean(evaluateNode(ast.right, ctx));
      }
      const left = evaluateNode(ast.left, ctx);
      const right = evaluateNode(ast.right, ctx);
      switch (op) {
        case '=': case '!=': case '<': case '>': case '<=': case '>=':
          return compare(op, left, right);
        case '+': return toNumber(left) + toNumber(right);
        case '-': return toNumber(left) - toNumber(right);
        case '*': return toNumber(left) * toNumber(right);
        case 'div': return toNumber(left) / toNumber(right);
        case 'mod': return toNumber(left) % toNumber(right);
        default: throw new Error(`Unsupported XPath operator '${op}'`);
      }
    }

    case 'union': {
      const left = evaluateNode(ast.left, ctx);
      const right = evaluateNode(ast.right, ctx);
      if (!isNodeSet(left) || !isNodeSet(right)) {
        throw new TypeError('The XPath union operator requires node-sets on both sides');
      }
      return toDocumentOrder([...left, ...right]);
    }

    case 'call': {
      const fn = FUNCTIONS[ast.name];
      if (!fn) throw new Error(`Unknown XPath function '${ast.name}()'`);
      // last() and position() read the context rather than arguments.
      const args = ast.args.map((a) => evaluateNode(a, ctx));
      return fn(ctx, ...args);
    }

    case 'filter': {
      const base = evaluateNode(ast.expr, ctx);
      if (!isNodeSet(base)) throw new TypeError('A predicate can only filter a node-set');
      return applyPredicate(base, ast.predicate, ctx);
    }

    case 'path': {
      let current;
      if (ast.absolute) {
        current = [documentRoot(ctx.node)];
      } else if (ast.base) {
        const base = evaluateNode(ast.base, ctx);
        if (!isNodeSet(base)) throw new TypeError('Path base must evaluate to a node-set');
        current = base;
      } else {
        current = [ctx.node];
      }

      for (const step of ast.steps) {
        const collected = [];
        for (const node of current) {
          for (const candidate of axisNodes(node, step.axis)) {
            if (matchesTest(candidate, step.test, step.axis)) collected.push(candidate);
          }
        }
        // Reverse axes number their positions from the context node outwards;
        // document-order sorting happens after predicates for that reason.
        const reverseAxis = ['ancestor', 'ancestor-or-self', 'preceding', 'preceding-sibling'].includes(step.axis);
        let result = reverseAxis ? collected : toDocumentOrder(collected);
        for (const predicate of step.predicates) {
          result = applyPredicate(result, predicate, ctx);
        }
        current = reverseAxis ? toDocumentOrder(result) : result;
      }
      return current;
    }

    default:
      throw new Error(`Unsupported XPath node kind '${ast.kind}'`);
  }
}

function applyPredicate(nodes, predicate, outerCtx) {
  const size = nodes.length;
  const kept = [];
  for (let i = 0; i < size; i += 1) {
    const ctx = { node: nodes[i], position: i + 1, size, root: outerCtx.root };
    const value = evaluateNode(predicate, ctx);
    // A numeric predicate is shorthand for `position() = n`.
    if (typeof value === 'number') {
      if (value === i + 1) kept.push(nodes[i]);
    } else if (toBoolean(value)) {
      kept.push(nodes[i]);
    }
  }
  return kept;
}

/* ────────────────────────────── public API ─────────────────────────────── */

const AST_CACHE = new Map();
const AST_CACHE_LIMIT = 500;

/** Parse (and memoise) an XPath expression. */
export function compile(expression) {
  const cached = AST_CACHE.get(expression);
  if (cached) return cached;
  const ast = new Parser(tokenize(expression), expression).parse();
  if (AST_CACHE.size >= AST_CACHE_LIMIT) AST_CACHE.clear();
  AST_CACHE.set(expression, ast);
  return ast;
}

/**
 * Evaluate an expression against a context node.
 * @param {string} expression
 * @param {object} contextNode A domhandler node (cheerio's `$.root()[0]`, etc).
 * @returns {any[]|string|number|boolean} node-set, or a primitive.
 */
export function evaluate(expression, contextNode) {
  const ast = compile(expression);
  return evaluateNode(ast, { node: contextNode, position: 1, size: 1, root: documentRoot(contextNode) });
}

/** Always returns an array of nodes; primitives become a single-item array. */
export function evaluateToNodes(expression, contextNode) {
  const result = evaluate(expression, contextNode);
  return isNodeSet(result) ? result : [];
}

/** Convenience: the string-value of every result. */
export function evaluateToStrings(expression, contextNode) {
  const result = evaluate(expression, contextNode);
  if (isNodeSet(result)) return result.map(stringValue);
  return [toStringValue(result)];
}

/** Convenience: the string-value of the first result (`''` when empty). */
export function evaluateToString(expression, contextNode) {
  const result = evaluate(expression, contextNode);
  if (isNodeSet(result)) return result.length ? stringValue(result[0]) : '';
  return toStringValue(result);
}

/** Cheap syntax check — used by the recipe validator. */
export function validateXPath(expression) {
  try {
    compile(expression);
    return { valid: true, error: null };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}
