/* Types for the vendored QR encoder. This file is the app's, not the box's —
 * the `.js` beside it is a copy and must not be edited here. */

/**
 * Encode `text` and return a square matrix of modules: `matrix[row][col]`
 * true means a dark module.
 *
 * UTF-8 byte mode, error-correction level M, best mask chosen by the
 * standard's penalty scoring, smallest type (version) that fits. No quiet
 * zone — the caller adds at least four modules of margin, or no camera will
 * read it.
 */
export declare function qrMatrix(text: string): boolean[][]
