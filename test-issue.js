const { DocumentParser } = require('./out/parser/documentParser');

const code = `globdecl = {
	#define ABS
	a = 3;
	_e = 3;
	private _ett = {

	};
	private _b = 4434;
};`;

const parser = new DocumentParser();
const symbols = parser.parse(code);

console.log('=== OUTLINE ===\n');

function printSymbol(symbol, indent = 0) {
    const spaces = '  '.repeat(indent);
    console.log(`${spaces}${symbol.name} (${symbol.type})`);
    if (symbol.children && symbol.children.length > 0) {
        symbol.children.forEach(child => printSymbol(child, indent + 1));
    }
}

symbols.forEach(s => printSymbol(s));

console.log('\n=== DETAILS ===');
console.log('Total root symbols:', symbols.length);
symbols.forEach(s => {
    console.log(`${s.name}: ${s.children?.length || 0} children`);
});

