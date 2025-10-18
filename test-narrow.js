const { DocumentParser } = require('./out/parser/documentParser');

// Добавляем по строчке
const tests = [
    `xtest = {
        _data = [];
        { _type = 1; } foreach [];
    };`,
    `xtest = {
        _data = [];
        { reverse _inhList; } foreach [];
    };`,
    `xtest = {
        _data = [];
        { _data pushBack "x"; } foreach [];
    };`,
    `xtest = {
        _data = [];
        {
            _type = 1;
            reverse _inhList;
        } foreach [];
    };`,
];

tests.forEach((code, i) => {
    console.log(`\n=== Test ${i+1} ===`);
    const parser = new DocumentParser();
    const symbols = parser.parse(code);
    console.log(`✅ ${symbols.length} symbols`);
});

