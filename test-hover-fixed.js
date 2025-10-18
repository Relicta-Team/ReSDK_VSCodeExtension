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
    getText: () => code
};

console.log('=== HOVER TEST ===\n');

// Test hover at myFunc
console.log('1. Hover on myFunc:');
const hover1 = provider.provideHover(mockDocument, { line: 2, character: 2 });
if (hover1) {
    console.log(hover1.contents.value);
}

console.log('\n2. Hover on GLOBAL_FUNC:');
const hover2 = provider.provideHover(mockDocument, { line: 13, character: 2 });
if (hover2) {
    console.log(hover2.contents.value);
}

console.log('\n3. Hover on MY_MACRO:');
const hover3 = provider.provideHover(mockDocument, { line: 16, character: 10 });
if (hover3) {
    console.log(hover3.contents.value);
} else {
    console.log('No hover (macro not found)');
}

