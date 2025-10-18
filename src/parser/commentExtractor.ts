/**
 * Extract comments that precede a symbol
 */

/**
 * Extract comment from the line(s) immediately above a symbol
 * Returns the comment text or undefined if no comment found
 */
export function extractPrecedingComment(text: string, symbolLine: number): string | undefined {
    const lines = text.split('\n');
    
    if (symbolLine <= 0 || symbolLine >= lines.length) {
        return undefined;
    }

    const comments: string[] = [];
    let currentLine = symbolLine - 1;

    // Walk backwards to collect comments
    while (currentLine >= 0) {
        const line = lines[currentLine].trim();
        
        // Empty line - stop looking
        if (line === '') {
            break;
        }

        // Single-line comment: // ...
        if (line.startsWith('//')) {
            comments.unshift(line.substring(2).trim());
            currentLine--;
            continue;
        }

        // Multi-line comment end: */
        if (line.endsWith('*/')) {
            const blockCommentLines: string[] = [];
            let foundStart = false;

            // Collect all lines of block comment
            while (currentLine >= 0 && !foundStart) {
                const blockLine = lines[currentLine].trim();
                
                if (blockLine.startsWith('/*')) {
                    // Found start of block comment
                    foundStart = true;
                    const content = blockLine.substring(2, blockLine.indexOf('*/')).trim();
                    if (content) {
                        blockCommentLines.unshift(content);
                    }
                } else if (blockLine.endsWith('*/')) {
                    const content = blockLine.substring(0, blockLine.lastIndexOf('*/')).trim();
                    if (content) {
                        blockCommentLines.unshift(content);
                    }
                } else {
                    // Middle line of block comment
                    let content = blockLine;
                    // Remove leading * if present
                    if (content.startsWith('*')) {
                        content = content.substring(1).trim();
                    }
                    if (content) {
                        blockCommentLines.unshift(content);
                    }
                }

                currentLine--;
            }

            comments.unshift(...blockCommentLines);
            break;
        }

        // Not a comment - stop
        break;
    }

    return comments.length > 0 ? comments.join('\n') : undefined;
}

