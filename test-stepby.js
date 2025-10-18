const { DocumentParser } = require('./out/parser/documentParser');

const tests = [
    `xtest = { _data = []; };`,
    `xtest = { { _x } foreach []; };`,
    `xtest = { _data = []; { _x } foreach []; };`,
    `xtest = {
        _data = [];
        { _x } foreach [];
    };`,
];

tests.forEach((code, i) => {
    console.log(`\n=== Test ${i+1} ===`);
    console.log(code);
    const parser = new DocumentParser();
    const symbols = parser.parse(code);
    console.log(`Result: ${symbols.length} symbols - ${symbols.map(s => s.name).join(', ')}`);
});

