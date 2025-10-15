// ======================================================
// SQF Tokenizer - ported from sqf-master/sqf/base_tokenizer.py
// ======================================================

/**
 * Tokenize SQF source code into array of strings
 * Based on Python implementation: https://github.com/LordGolias/sqf
 */
export function tokenize(statement: string): string[] {
    // The len=2 tokens have to be first!
    const regex = /(\#\#|\#include|\#else|\#endif|\#ifndef|\#ifdef|\#define|\#undef|\\\n|\r\n|>>|\/\*|\*\/|\|\||\/\/|!=|<=|>=|==|\n|\t|[\"\' =:\{\}\(\)\[\];\/,\!\/\#\*\%\^\-\+<>])/g;
    
    return statement.split(regex).filter(token => token !== '');
}

