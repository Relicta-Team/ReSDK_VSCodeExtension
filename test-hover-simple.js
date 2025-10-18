const { HoverProvider } = require('./out/providers/hoverProvider');
const { DocumentParser } = require('./out/parser/documentParser');

const code = `/* 
 * Global function without params
 * Uses _this variable
 */
GLOBAL_FUNC = {
    _this select 0
};`;

console.log('Parsing code...\n');
const parser = new DocumentParser();
const symbols = parser.parse(code);

console.log('Symbols found:');
symbols.forEach(s => {
    console.log(`  ${s.name} at line ${s.range.start.line + 1}, char ${s.selectionRange.start.character}-${s.selectionRange.end.character}`);
});

const provider = new HoverProvider();
const mockDocument = { uri: 'test.sqf', getText: () => code };

console.log('\nTrying hover at line 5 (GLOBAL_FUNC line), char 0-11:');
for (let char = 0; char < 15; char++) {
    const hover = provider.provideHover(mockDocument, { line: 4, character: char });
    if (hover) {
        console.log(`  Found at char ${char}!`);
        console.log(hover.contents.value.substring(0, 100));
        break;
    }
}

