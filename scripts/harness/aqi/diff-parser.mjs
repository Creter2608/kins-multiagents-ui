/**
 * scripts/harness/aqi/diff-parser.mjs
 * Unified diff parser with monotonic churn calculation.
 */

/**
 * Parses a unified git diff text into structured file records.
 *
 * @param {string} diffText
 * @returns {Array<object>}
 */
export function parseUnifiedDiff(diffText) {
  if (typeof diffText !== 'string' || !diffText.trim()) {
    return [];
  }

  const files = [];
  const rawSections = diffText.split(/^diff --git /m);

  for (const section of rawSections) {
    if (!section.trim()) continue;

    const lines = section.split('\n');
    const headerLine = lines[0] || '';
    const headerParts = headerLine.split(' ');
    const oldPathRaw = headerParts[0]?.replace(/^a\//, '') || '';
    const newPathRaw = headerParts[1]?.replace(/^b\//, '') || '';

    let oldPath = oldPathRaw;
    let newPath = newPathRaw;
    let isNew = false;
    let isDeleted = false;
    let isRename = false;
    let isBinary = false;

    let addedLinesCount = 0;
    let deletedLinesCount = 0;
    const addedLines = [];
    const addedLineNumbers = [];
    const hunks = [];
    let currentHunk = null;
    let currentNewLineNumber = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('new file mode')) {
        isNew = true;
      } else if (line.startsWith('deleted file mode')) {
        isDeleted = true;
      } else if (line.startsWith('similarity index') || line.startsWith('rename from')) {
        isRename = true;
      } else if (line.startsWith('Binary files')) {
        isBinary = true;
      } else if (line.startsWith('--- ')) {
        const p = line.slice(4).trim();
        if (p === '/dev/null') isNew = true;
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4).trim();
        if (p === '/dev/null') isDeleted = true;
        else newPath = p.replace(/^b\//, '');
      } else if (line.startsWith('@@ ')) {
        const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (hunkMatch) {
          const oldStart = parseInt(hunkMatch[1], 10);
          const oldLines = parseInt(hunkMatch[2] || '1', 10);
          const newStart = parseInt(hunkMatch[3], 10);
          const newLines = parseInt(hunkMatch[4] || '1', 10);

          currentHunk = { oldStart, oldLines, newStart, newLines };
          hunks.push(currentHunk);
          currentNewLineNumber = newStart;
        }
      } else if (currentHunk) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          addedLinesCount++;
          addedLines.push(line.slice(1));
          addedLineNumbers.push(currentNewLineNumber);
          currentNewLineNumber++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          deletedLinesCount++;
        } else if (line.startsWith(' ')) {
          currentNewLineNumber++;
        }
      }
    }

    files.push({
      oldPath: isNew ? null : oldPath,
      newPath: isDeleted ? null : newPath,
      path: isDeleted ? oldPath : newPath,
      isNew,
      isDeleted,
      isRename,
      isBinary,
      addedLinesCount,
      deletedLinesCount,
      semanticChurn: addedLinesCount + deletedLinesCount,
      addedLines,
      addedLineNumbers,
      hunks
    });
  }

  return files;
}
