const { DocumentParser } = require('./out/parser/documentParser');

// Простейший тест
const tests = [
    'xtest = {};',
    'xtest = { _x };',
    'xtest = { _x } foreach [];',
    'xtest = { _x = 1 };',
];

tests.forEach(code => {
    console.log(`Testing: ${code}`);
    const parser = new DocumentParser();
    const symbols = parser.parse(code);
    console.log(`  Result: ${symbols.length} symbols - ${symbols.map(s => s.name).join(', ')}`);
    console.log('');
});

