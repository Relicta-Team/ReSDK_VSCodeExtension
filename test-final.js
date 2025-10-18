const { DocumentParser } = require('./out/parser/documentParser');

const code = `xtest = {
    _data = [];
    {
        _type = missionNamespace getVariable ("pt_"+_x);
        reverse _inhList;
        _data pushBack (_inhList joinString "/");
    } foreach p_table_allclassnames;
    text (_data joinString endl)
};`;

console.log('=== FINAL TEST ===\n');
const parser = new DocumentParser();
const symbols = parser.parse(code);

console.log(`Result: ${symbols.length} symbols`);
symbols.forEach(s => console.log(`  - ${s.name} (${s.type})`));

if (symbols.find(s => s.name === 'xtest' && s.type === 'function')) {
    console.log('\n✅✅✅ SUCCESS! xtest function found!');
} else {
    console.log('\n❌ Failed');
}

