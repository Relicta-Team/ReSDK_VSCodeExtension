const { DocumentParser } = require('./out/parser/documentParser');

const tests = [
    `xtest = {
    _data = [];
    text (_data joinString endl)
};`,
    `xtest = {
    _data = [];
    { reverse _inhList; } foreach p_table_allclassnames;
    text (_data joinString endl)
};`,
    `xtest = {
    _data = [];
    { _type = missionNamespace getVariable ("pt_"+_x); } foreach p_table_allclassnames;
};`,
];

tests.forEach((code, i) => {
    console.log(`\n=== Test ${i+1} ===`);
    const parser = new DocumentParser();
    const symbols = parser.parse(code);
    if (symbols.length > 0) {
        console.log(`✅ ${symbols.length} symbols`);
    } else {
        console.log(`❌ 0 symbols`);
    }
});

