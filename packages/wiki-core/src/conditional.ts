const MAX_EXPRESSION_LENGTH = 512;
const MAX_TOKENS = 128;
const MAX_PARSE_DEPTH = 16;

type Scalar = string | number | boolean;
type Token =
  | { type: 'identifier'; value: string }
  | { type: 'literal'; value: Scalar }
  | { type: 'operator'; value: '!' | '==' | '!=' | '&&' | '||' }
  | { type: 'punctuation'; value: '(' | ')' | ',' }
  | { type: 'eof' };

export interface ConditionalEvaluation {
  readonly value: boolean;
  readonly error: string | null;
}

/**
 * Evaluate the bounded MineWiki conditional language. This deliberately is not
 * JavaScript: property access, calls other than defined(name), assignments and
 * executable expressions are rejected.
 */
export function evaluateConditionalExpression(
  expression: string,
  params: Readonly<Record<string, string>>,
  reservedParams: Readonly<{ calleeTitle?: string }> = {},
): ConditionalEvaluation {
  try {
    const tokens = tokenize(expression);
    const parser = new ConditionalParser(tokens, params, reservedParams);
    const value = parser.parse();
    return { value: truthy(value), error: null };
  } catch (error) {
    return {
      value: false,
      error: error instanceof Error ? error.message : '조건식을 해석할 수 없습니다.',
    };
  }
}

function tokenize(raw: string): Token[] {
  const expression = String(raw).trim();
  if (!expression) throw new Error('빈 조건식은 사용할 수 없습니다.');
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`조건식은 ${MAX_EXPRESSION_LENGTH}자를 초과할 수 없습니다.`);
  }

  const tokens: Token[] = [];
  let index = 0;
  const push = (token: Token) => {
    tokens.push(token);
    if (tokens.length > MAX_TOKENS) throw new Error(`조건식 토큰은 ${MAX_TOKENS}개를 초과할 수 없습니다.`);
  };

  while (index < expression.length) {
    const char = expression[index]!;
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    const operator = expression.slice(index).match(/^(?:==|!=|&&|\|\||!)/u)?.[0];
    if (operator) {
      push({ type: 'operator', value: operator as Extract<Token, { type: 'operator' }>['value'] });
      index += operator.length;
      continue;
    }
    if (char === '(' || char === ')' || char === ',') {
      push({ type: 'punctuation', value: char });
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      index += 1;
      let closed = false;
      while (index < expression.length) {
        const current = expression[index]!;
        if (current === quote) {
          closed = true;
          index += 1;
          break;
        }
        if (current === '\\') {
          const escaped = expression[index + 1];
          if (escaped === undefined) break;
          if (!['\\', '"', "'", 'n', 'r', 't'].includes(escaped)) {
            throw new Error('지원되지 않는 문자열 이스케이프입니다.');
          }
          value += ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[escaped] ?? escaped;
          index += 2;
          continue;
        }
        value += current;
        index += 1;
      }
      if (!closed) throw new Error('닫히지 않은 문자열 리터럴입니다.');
      push({ type: 'literal', value });
      continue;
    }
    const number = expression.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?/u)?.[0];
    if (number) {
      push({ type: 'literal', value: Number(number) });
      index += number.length;
      continue;
    }
    const identifier = expression.slice(index).match(/^[A-Za-z_가-힣][A-Za-z0-9_가-힣]*/u)?.[0];
    if (identifier) {
      if (identifier === 'true' || identifier === 'false') {
        push({ type: 'literal', value: identifier === 'true' });
      } else {
        push({ type: 'identifier', value: identifier });
      }
      index += identifier.length;
      continue;
    }
    throw new Error(`지원되지 않는 조건식 문자입니다: ${char}`);
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

class ConditionalParser {
  private index = 0;
  private depth = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly params: Readonly<Record<string, string>>,
    private readonly reservedParams: Readonly<{ calleeTitle?: string }>,
  ) {}

  parse(): Scalar {
    const result = this.parseOr();
    if (this.peek().type !== 'eof') throw new Error('조건식 뒤에 해석할 수 없는 내용이 있습니다.');
    return result;
  }

  private parseOr(): Scalar {
    let left = this.parseAnd();
    while (this.matchOperator('||')) {
      const right = this.parseAnd();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  private parseAnd(): Scalar {
    let left = this.parseEquality();
    while (this.matchOperator('&&')) {
      const right = this.parseEquality();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  private parseEquality(): Scalar {
    let left = this.parseUnary();
    while (true) {
      if (this.matchOperator('==')) left = equal(left, this.parseUnary());
      else if (this.matchOperator('!=')) left = !equal(left, this.parseUnary());
      else break;
    }
    return left;
  }

  private parseUnary(): Scalar {
    if (this.matchOperator('!')) return !truthy(this.parseUnary());
    return this.parsePrimary();
  }

  private parsePrimary(): Scalar {
    const token = this.peek();
    if (token.type === 'literal') {
      this.index += 1;
      return token.value;
    }
    if (token.type === 'identifier') {
      this.index += 1;
      if (token.value === 'defined' && this.matchPunctuation('(')) {
        const name = this.peek();
        if (name.type !== 'identifier') throw new Error('defined()에는 매개변수 이름이 필요합니다.');
        this.index += 1;
        if (!this.matchPunctuation(')')) throw new Error('defined()의 닫는 괄호가 필요합니다.');
        return this.lookup(name.value) !== undefined;
      }
      return this.lookup(token.value) ?? '';
    }
    if (this.matchPunctuation('(')) {
      this.depth += 1;
      if (this.depth > MAX_PARSE_DEPTH) throw new Error(`조건식 괄호는 ${MAX_PARSE_DEPTH}단계까지만 중첩할 수 있습니다.`);
      const value = this.parseOr();
      if (!this.matchPunctuation(')')) throw new Error('조건식의 닫는 괄호가 필요합니다.');
      this.depth -= 1;
      return value;
    }
    throw new Error('조건식 값이 필요합니다.');
  }

  private lookup(name: string): string | undefined {
    if (name === 'calleeTitle') return this.reservedParams.calleeTitle;
    return Object.prototype.hasOwnProperty.call(this.params, name) ? this.params[name] : undefined;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { type: 'eof' };
  }

  private matchOperator(value: Extract<Token, { type: 'operator' }>['value']): boolean {
    const token = this.peek();
    if (token.type !== 'operator' || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  private matchPunctuation(value: Extract<Token, { type: 'punctuation' }>['value']): boolean {
    const token = this.peek();
    if (token.type !== 'punctuation' || token.value !== value) return false;
    this.index += 1;
    return true;
  }
}

function truthy(value: Scalar): boolean {
  return typeof value === 'string' ? value.length > 0 : Boolean(value);
}

function equal(left: Scalar, right: Scalar): boolean {
  if (typeof left === typeof right) return left === right;
  return String(left) === String(right);
}
