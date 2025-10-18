const { DiagnosticsProvider } = require('./out/providers/diagnosticsProvider');

const tests = [
    { name: 'Global function redef', code: 'fnc = {};\nfnc = {};', shouldWarn: true },
    { name: 'Local function redef', code: '_fnc = {};\n_fnc = {};', shouldWarn: false },
    { name: 'Macro redef', code: '#define M 1\n#define M 2', shouldWarn: true },
];

const provider = new DiagnosticsProvider();

tests.forEach(test => {
    console.log(`\n${test.name}:`);
    const mockDoc = { uri: 'test.sqf', getText: () => test.code };
    const diagnostics = provider.provideDiagnostics(mockDoc);
    const warnings = diagnostics.filter(d => d.message.includes('already defined'));
    
    const hasWarning = warnings.length > 0;
    const result = hasWarning === test.shouldWarn ? '✅' : '❌';
    console.log(`  ${result} Warning: ${hasWarning ? 'YES' : 'NO'} (expected: ${test.shouldWarn ? 'YES' : 'NO'})`);
});

