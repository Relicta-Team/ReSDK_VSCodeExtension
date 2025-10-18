const { DocumentParser } = require('./out/parser/documentParser');

const code = `#define SIMPLE_MACRO 100
#define MACRO_FUNC(x, y) (x + y)

globdecl = {
	a = 3;
	_e = 3;
	private _ett = {
		_nested = 1;
	};
	private _b = 4434;
};

GLOBAL_VAR = 123;

testFunc = {
	_data = [];
	{
		_type = missionNamespace getVariable ("pt_"+_x);
		reverse _inhList;
		_data pushBack (_inhList joinString "/");
	} foreach p_table_allclassnames;
	text (_data joinString endl)
};`;

const parser = new DocumentParser();
const symbols = parser.parse(code);

console.log('=== FINAL OUTLINE TEST ===\n');

function printSymbol(symbol, indent = 0) {
    const spaces = '  '.repeat(indent);
    const icon = symbol.type === 'function' || symbol.type === 'macroFunction' ? 'ƒ' : 
                 symbol.type === 'macro' ? '#' : 
                 symbol.type === 'localVariable' ? '_' : 'G';
    console.log(`${spaces}${icon} ${symbol.name} (${symbol.type})`);
    if (symbol.children && symbol.children.length > 0) {
        symbol.children.forEach(child => printSymbol(child, indent + 1));
    }
}

symbols.forEach(s => printSymbol(s));

console.log(`\n✅ Total root symbols: ${symbols.length}`);

