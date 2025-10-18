const { DocumentParser } = require('./out/parser/documentParser');

const tests = [
    '{ _x } foreach [];',
    '{ _x = 1 } foreach [];',
    '{ _x = a b } foreach [];',
    '{ missionNamespace getVariable "x" } foreach [];',
];

tests.forEach(code => {
    console.log(`\nTesting: ${code}`);
    const parser = new DocumentParser();
    try {
        const symbols = parser.parse(code);
        console.log(`  ✅ Success: ${symbols.length} symbols`);
    } catch(e) {
        console.log(`  ❌ Failed: ${e.message}`);
    }
});

