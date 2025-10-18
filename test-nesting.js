const { DocumentParser } = require('./out/parser/documentParser');

const code = `xtest = {
	_data = [];
	{
		_type = missionNamespace getVariable ("pt_"+_x);
		reverse _inhList;
		_data pushBack (_inhList joinString "/");
	} foreach p_table_allclassnames;
	text (_data joinString endl)
};

globalVar = 123;`;

const parser = new DocumentParser();
const symbols = parser.parse(code);

console.log('Symbols (with nesting):\n');

function printSymbol(symbol, indent = 0) {
    const spaces = '  '.repeat(indent);
    console.log(`${spaces}${symbol.name} (${symbol.type})`);
    if (symbol.children && symbol.children.length > 0) {
        symbol.children.forEach(child => printSymbol(child, indent + 1));
    }
}

symbols.forEach(s => printSymbol(s));

