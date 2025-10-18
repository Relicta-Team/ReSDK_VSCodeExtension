const { DocumentParser } = require('./out/parser/documentParser');

const code = `globdecl = {
	a = 3;
	_e = 3;
	private _b = 4434;
};`;

const parser = new DocumentParser();
const symbols = parser.parse(code);

console.log('Symbols:\n');

function printSymbol(symbol, indent = 0) {
    const spaces = '  '.repeat(indent);
    console.log(`${spaces}${symbol.name} (${symbol.type})`);
    if (symbol.children && symbol.children.length > 0) {
        symbol.children.forEach(child => printSymbol(child, indent + 1));
    }
}

symbols.forEach(s => printSymbol(s));

console.log('\n--- Checking types ---');
const findSymbol = (name) => {
    for (const s of symbols) {
        if (s.name === name) return s;
        if (s.children) {
            const found = s.children.find(c => c.name === name);
            if (found) return found;
        }
    }
    return null;
};

console.log('a:', findSymbol('a')?.type);
console.log('_e:', findSymbol('_e')?.type);
console.log('_b:', findSymbol('_b')?.type);

