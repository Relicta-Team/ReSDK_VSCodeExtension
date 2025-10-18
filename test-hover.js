const { HoverProvider } = require('./out/providers/hoverProvider');

const code = `// This is a test function
// It adds two numbers
myFunc = {
    params ["_x", "_y"];
    _x + _y
};

/* 
 * Global function without params
 * Uses _this variable
 */
GLOBAL_FUNC = {
    _this select 0
};

#define MY_MACRO 100`;

const provider = new HoverProvider();

const mockDocument = {
    uri: 'test.sqf',
    getText: () => code,
    positionAt: (offset) => ({ line: 0, character: 0 })
};

// Test hover at different positions
const tests = [
    { line: 2, char: 2, name: 'myFunc' },  // hover over myFunc
    { line: 12, char: 2, name: 'GLOBAL_FUNC' },  // hover over GLOBAL_FUNC
    { line: 16, char: 10, name: 'MY_MACRO' }  // hover over MY_MACRO
];

tests.forEach(test => {
    console.log(`\n=== Hover at ${test.name} (line ${test.line + 1}) ===`);
    const hover = provider.provideHover(mockDocument, { line: test.line, character: test.char });
    
    if (hover) {
        console.log(hover.contents.value);
    } else {
        console.log('No hover info');
    }
});

