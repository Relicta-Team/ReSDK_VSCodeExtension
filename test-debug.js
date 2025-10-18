const { DocumentParser } = require('./out/parser/documentParser');

const tests = [
    'x = "a" + "b";',
    'x = "a" + _x;',
    'x = ("a" + _x);',
    'x = missionNamespace getVariable "x";',
    'x = missionNamespace getVariable ("x");',
    'x = missionNamespace getVariable ("a"+_x);',
];

tests.forEach(code => {
    console.log(`Test: ${code}`);
    const parser = new DocumentParser();
    const symbols = parser.parse(code);
    console.log(`  Result: ${symbols.length} symbols\n`);
});

