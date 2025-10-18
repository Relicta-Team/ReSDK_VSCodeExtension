const { DocumentParser } = require('./out/parser/documentParser');
const code = `globdecl = { a = 3; _e = 3; private _b = 4434; };`;
const parser = new DocumentParser();
const symbols = parser.parse(code);
console.log(JSON.stringify(symbols.map(s => ({ 
    name: s.name, 
    type: s.type, 
    children: s.children?.map(c => ({ name: c.name, type: c.type })) 
})), null, 2));

