const fs = require('fs');
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

let output = '=== OUTLINE ===\n\n';

function printSymbol(symbol, indent = 0) {
    const spaces = '  '.repeat(indent);
    output += `${spaces}${symbol.name} (${symbol.type})\n`;
    if (symbol.children && symbol.children.length > 0) {
        symbol.children.forEach(child => printSymbol(child, indent + 1));
    }
}

symbols.forEach(s => printSymbol(s));

output += '\n=== DETAILS ===\n';
output += 'Total root symbols: ' + symbols.length + '\n';
symbols.forEach(s => {
    output += `${s.name}: ${s.children?.length || 0} children\n`;
});

fs.writeFileSync('test-output.txt', output);
console.log('Written to test-output.txt');

