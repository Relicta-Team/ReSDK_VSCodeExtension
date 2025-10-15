// ======================================================
// SQF Types - ported from sqf-master/sqf/types.py
// ======================================================

export abstract class BaseType {
    abstract toString(): string;
}

export abstract class Type extends BaseType {
    abstract get isUndefined(): boolean;
    abstract get value(): any;
}

export class ConstantValue extends Type {
    protected _value: any;

    constructor(value?: any) {
        super();
        this._value = value;
    }

    get isUndefined(): boolean {
        return this._value === undefined || this._value === null;
    }

    get value(): any {
        return this._value;
    }

    toString(): string {
        return this.constructor.name;
    }
}

export class SQFBoolean extends ConstantValue {
    constructor(value?: boolean) {
        super(value);
    }

    toString(): string {
        if (this.isUndefined) return 'undefined';
        return this._value ? 'true' : 'false';
    }
}

export class SQFString extends ConstantValue {
    public container: string | null = null;

    constructor(value?: string) {
        let processedValue = value;
        let containerChar: string | null = null;
        
        if (value) {
            const firstChar = value[0];
            const lastChar = value[value.length - 1];
            if (firstChar === lastChar && (firstChar === '"' || firstChar === "'")) {
                processedValue = value.substring(1, value.length - 1);
                containerChar = firstChar;
            }
        }
        
        super(processedValue);
        this.container = containerChar;
    }

    toString(): string {
        if (this.isUndefined) return 'undefined';
        return `${this.container}${this._value}${this.container}`;
    }
}

export class SQFNumber extends ConstantValue {
    constructor(value?: number) {
        super(value);
    }

    toString(): string {
        if (this.isUndefined) return 'undefined';
        if (Number.isInteger(this._value)) {
            return this._value.toString();
        }
        return this._value.toFixed(2);
    }
}

export class Variable extends Type {
    private _name: string;

    constructor(name: string) {
        super();
        this._name = name;
    }

    get name(): string {
        return this._name;
    }

    get isUndefined(): boolean {
        return false;
    }

    get isGlobal(): boolean {
        return this._name[0] !== '_';
    }

    get value(): any {
        return null;
    }

    toString(): string {
        return this._name;
    }
}

export class Keyword extends BaseType {
    private _token: string;
    private _uniqueToken: string;

    constructor(token: string) {
        super();
        this._token = token;
        this._uniqueToken = token.toLowerCase();
    }

    get value(): string {
        return this._token;
    }

    get uniqueToken(): string {
        return this._uniqueToken;
    }

    toString(): string {
        return this._token;
    }
}

export class Statement extends BaseType {
    public content: BaseType[];
    public parenthesis: string | null;
    public ending: string | null;

    constructor(tokens: BaseType[], parenthesis?: string | null, ending?: string | null) {
        super();
        this.content = tokens;
        this.parenthesis = parenthesis || null;
        this.ending = ending || null;
    }

    toString(): string {
        let result = '';
        if (this.parenthesis) {
            result += this.parenthesis[0];
        }
        result += this.content.map(t => t.toString()).join('');
        if (this.parenthesis) {
            result += this.parenthesis[1];
        }
        if (this.ending) {
            result += this.ending;
        }
        return result;
    }
}

export class Code extends Type {
    public content: BaseType[];

    constructor(tokens?: BaseType[]) {
        super();
        this.content = tokens || [];
    }

    get isUndefined(): boolean {
        return this.content.length === 0;
    }

    get value(): any {
        return this.content;
    }

    toString(): string {
        return '{' + this.content.map(t => t.toString()).join('') + '}';
    }
}

export class SQFArray extends Type {
    private _values: Type[];

    constructor(values?: Type[]) {
        super();
        this._values = values || [];
    }

    get isUndefined(): boolean {
        return this._values === null || this._values === undefined;
    }

    get value(): Type[] {
        return this._values;
    }

    toString(): string {
        if (this.isUndefined) return '[undefined]';
        return '[' + this._values.map(v => v.toString()).join(',') + ']';
    }
}

export class Namespace extends Type {
    private _token: string;

    constructor(token: string) {
        super();
        this._token = token;
    }

    get isUndefined(): boolean {
        return false;
    }

    get value(): string {
        return this._token;
    }

    toString(): string {
        return this._token;
    }
}

export class Preprocessor extends Keyword {
    constructor(token: string) {
        super(token);
    }
}

// Parser-specific types
export class ParserKeyword extends BaseType {
    private _value: string;

    constructor(value: string) {
        super();
        this._value = value;
    }

    get value(): string {
        return this._value;
    }

    toString(): string {
        return this._value;
    }
}

export class Comment extends BaseType {
    private _text: string;

    constructor(text: string) {
        super();
        this._text = text;
    }

    toString(): string {
        return this._text;
    }
}

export class Space extends BaseType {
    toString(): string {
        return ' ';
    }
}

export class Tab extends BaseType {
    toString(): string {
        return '\t';
    }
}

export class EndOfLine extends BaseType {
    private _value: string;

    constructor(value: string = '\n') {
        super();
        this._value = value;
    }

    toString(): string {
        return this._value;
    }
}

