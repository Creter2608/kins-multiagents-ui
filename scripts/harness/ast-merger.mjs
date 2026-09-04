/**
 * scripts/harness/ast-merger.mjs
 * 3-Way AST-Level Source and Worktree Merger.
 * Deterministically merges concurrent code edits by multiple agents,
 * resolving non-conflicting imports, interface properties, and disjoint declarations
 * without textual git conflict markers.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import tsModule from "typescript";

const ts = tsModule.default || tsModule;

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts"
]);

const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  ".eval",
  "node_modules",
  "dist",
  ".worktrees"
]);

/**
 * Normalizes code text for whitespace-invariant comparison.
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

/**
 * Detects TypeScript ScriptKind from file path.
 * @param {string} [filePath]
 * @returns {ts.ScriptKind}
 */
function getScriptKind(filePath) {
  if (!filePath) return ts.ScriptKind.TS;
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

/**
 * Extracts all imports and normalizes them into structured descriptors.
 * @param {ts.SourceFile} sf
 * @returns {Array<{
 *   specifier: string,
 *   isTypeOnly: boolean,
 *   defaultName?: string,
 *   namespaceName?: string,
 *   named: Array<{ importedName: string, localName: string, isTypeOnly: boolean }>,
 *   rawText: string
 * }>}
 */
function extractImports(sf) {
  const imports = [];

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;

    const specifier = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
      ? stmt.moduleSpecifier.text
      : "";
    if (!specifier) continue;

    const isTypeOnly = Boolean(stmt.importClause?.isTypeOnly);
    let defaultName = undefined;
    let namespaceName = undefined;
    const named = [];

    if (stmt.importClause) {
      if (stmt.importClause.name) {
        defaultName = stmt.importClause.name.text;
      }
      const nb = stmt.importClause.namedBindings;
      if (nb) {
        if (ts.isNamespaceImport(nb)) {
          namespaceName = nb.name.text;
        } else if (ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            const importedName = el.propertyName ? el.propertyName.text : el.name.text;
            const localName = el.name.text;
            named.push({
              importedName,
              localName,
              isTypeOnly: Boolean(el.isTypeOnly)
            });
          }
        }
      }
    }

    imports.push({
      specifier,
      isTypeOnly,
      defaultName,
      namespaceName,
      named,
      rawText: stmt.getText(sf)
    });
  }

  return imports;
}

/**
 * Merges imports from Base, Current, and Incoming.
 * @param {Array} baseImports
 * @param {Array} currentImports
 * @param {Array} incomingImports
 * @returns {{ code: string, autoMergedCount: number }}
 */
function mergeImports3Way(baseImports, currentImports, incomingImports) {
  let autoMergedCount = 0;

  // Group by specifier
  const specifiers = new Set([
    ...currentImports.map((i) => i.specifier),
    ...incomingImports.map((i) => i.specifier),
    ...baseImports.map((i) => i.specifier)
  ]);

  const outputLines = [];

  for (const spec of specifiers) {
    const bGroup = baseImports.filter((i) => i.specifier === spec);
    const cGroup = currentImports.filter((i) => i.specifier === spec);
    const iGroup = incomingImports.filter((i) => i.specifier === spec);

    // If current and incoming are byte-identical
    const cText = cGroup.map((i) => i.rawText).join("\n");
    const iText = iGroup.map((i) => i.rawText).join("\n");
    const bText = bGroup.map((i) => i.rawText).join("\n");

    if (cText === iText) {
      if (cText.length > 0) {
        outputLines.push(cText);
        if (cText !== bText && bText.length > 0) {
          autoMergedCount++;
        }
      }
      continue;
    }

    // If current is unchanged from base, take incoming
    if (cText === bText) {
      if (iText.length > 0) {
        outputLines.push(iText);
        autoMergedCount++;
      }
      continue;
    }

    // If incoming is unchanged from base, take current
    if (iText === bText) {
      if (cText.length > 0) {
        outputLines.push(cText);
      }
      continue;
    }

    // Both sides diverged: Attempt semantic merging of named/default imports
    // 1. Separate type-only imports from value imports if needed
    for (const typeOnly of [false, true]) {
      const cTyped = cGroup.filter((i) => i.isTypeOnly === typeOnly);
      const iTyped = iGroup.filter((i) => i.isTypeOnly === typeOnly);
      const bTyped = bGroup.filter((i) => i.isTypeOnly === typeOnly);

      if (cTyped.length === 0 && iTyped.length === 0) continue;

      // Handle side-effect only imports (no clause)
      const cSide = cTyped.find((i) => !i.defaultName && !i.namespaceName && i.named.length === 0);
      const iSide = iTyped.find((i) => !i.defaultName && !i.namespaceName && i.named.length === 0);
      if (cSide || iSide) {
        outputLines.push(`import "${spec}";`);
        autoMergedCount++;
        continue;
      }

      // Handle namespace imports
      const cNs = cTyped.find((i) => i.namespaceName);
      const iNs = iTyped.find((i) => i.namespaceName);
      if (cNs && iNs && cNs.namespaceName === iNs.namespaceName) {
        outputLines.push(`import * as ${cNs.namespaceName} from "${spec}";`);
        autoMergedCount++;
        continue;
      } else if (cNs && iNs && cNs.namespaceName !== iNs.namespaceName) {
        outputLines.push(`import * as ${cNs.namespaceName} from "${spec}";`);
        outputLines.push(`import * as ${iNs.namespaceName} from "${spec}";`);
        autoMergedCount++;
        continue;
      }

      // Merge default imports
      const cDef = cTyped.find((i) => i.defaultName)?.defaultName;
      const iDef = iTyped.find((i) => i.defaultName)?.defaultName;
      const bDef = bTyped.find((i) => i.defaultName)?.defaultName;
      let mergedDefault = undefined;
      if (cDef && iDef && cDef === iDef) {
        mergedDefault = cDef;
      } else if (cDef && (!bDef || cDef !== bDef) && !iDef) {
        mergedDefault = cDef;
      } else if (iDef && (!bDef || iDef !== bDef) && !cDef) {
        mergedDefault = iDef;
      } else if (cDef && iDef && cDef !== iDef) {
        // Separate default import declarations
        outputLines.push(`import ${cDef} from "${spec}";`);
        outputLines.push(`import ${iDef} from "${spec}";`);
        autoMergedCount++;
      }

      // Merge named imports
      const bNamed = bTyped.flatMap((i) => i.named);
      const cNamed = cTyped.flatMap((i) => i.named);
      const iNamed = iTyped.flatMap((i) => i.named);

      // Union of named specifiers preserving current order then incoming
      const mergedNamedList = [];
      const seenSpecifiers = new Set();

      for (const item of [...cNamed, ...iNamed]) {
        const key = `${item.importedName}:${item.localName}:${item.isTypeOnly}`;
        if (!seenSpecifiers.has(key)) {
          seenSpecifiers.add(key);
          mergedNamedList.push(item);
        }
      }

      // Format merged declaration
      if (mergedNamedList.length > 0 || mergedDefault) {
        const importPrefix = typeOnly ? "import type " : "import ";
        const formattedNamed = mergedNamedList.map((s) => {
          const tPrefix = s.isTypeOnly && !typeOnly ? "type " : "";
          if (s.propertyName && s.propertyName !== s.localName) {
            return `${tPrefix}${s.propertyName} as ${s.localName}`;
          }
          return `${tPrefix}${s.localName}`;
        });

        const parts = [];
        if (mergedDefault) {
          parts.push(mergedDefault);
        }
        if (formattedNamed.length > 0) {
          parts.push(`{ ${formattedNamed.join(", ")} }`);
        }

        outputLines.push(`${importPrefix}${parts.join(", ")} from "${spec}";`);
        autoMergedCount++;
      }
    }
  }

  return {
    code: outputLines.join("\n"),
    autoMergedCount
  };
}

/**
 * Extracts top-level declarations (excluding imports) with stable semantic keys.
 * @param {ts.SourceFile} sf
 * @returns {Map<string, { stmt: ts.Statement, kind: string, name: string, rawText: string }>}
 */
function extractTopLevelStatements(sf) {
  const map = new Map();
  let anonIdx = 0;

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) continue;

    let key = "";
    let kind = "statement";
    let name = "";

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      name = stmt.name.text;
      kind = "function";
      key = `func:${name}`;
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      name = stmt.name.text;
      kind = "class";
      key = `class:${name}`;
    } else if (ts.isInterfaceDeclaration(stmt)) {
      name = stmt.name.text;
      kind = "interface";
      key = `interface:${name}`;
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      name = stmt.name.text;
      kind = "type";
      key = `type:${name}`;
    } else if (ts.isEnumDeclaration(stmt)) {
      name = stmt.name.text;
      kind = "enum";
      key = `enum:${name}`;
    } else if (ts.isVariableStatement(stmt)) {
      kind = "variable";
      const decls = stmt.declarationList.declarations;
      if (decls.length === 1 && decls[0] && ts.isIdentifier(decls[0].name)) {
        name = decls[0].name.text;
        key = `var:${name}`;
      } else {
        name = normalizeText(stmt.getText(sf)).slice(0, 32);
        key = `var:${name}:${++anonIdx}`;
      }
    } else {
      kind = "statement";
      name = normalizeText(stmt.getText(sf)).slice(0, 32);
      key = `stmt:${normalizeText(stmt.getText(sf))}`;
    }

    map.set(key, {
      stmt,
      kind,
      name,
      rawText: stmt.getText(sf)
    });
  }

  return map;
}

/**
 * Attempts 3-way merge on interface or type-literal members.
 * @param {ts.Statement} baseStmt
 * @param {ts.Statement} currentStmt
 * @param {ts.Statement} incomingStmt
 * @param {ts.SourceFile} currentSf
 * @param {ts.SourceFile} incomingSf
 * @returns {{ success: boolean, code?: string, conflict?: import('./ast-merger.d.mts').ConflictRecord }}
 */
function tryMergeInterfaceMembers(baseStmt, currentStmt, incomingStmt, currentSf, incomingSf) {
  if (!ts.isInterfaceDeclaration(currentStmt) || !ts.isInterfaceDeclaration(incomingStmt)) {
    return { success: false };
  }

  // Verify headers match
  const cHeader = currentStmt.getText(currentSf).split("{")[0]?.trim();
  const iHeader = incomingStmt.getText(incomingSf).split("{")[0]?.trim();
  if (cHeader !== iHeader) {
    return { success: false };
  }

  const getMembersMap = (iface, sf) => {
    const m = new Map();
    for (const mem of iface.members) {
      const name = mem.name ? mem.name.getText(sf) : "";
      const kind = ts.SyntaxKind[mem.kind];
      const key = `${kind}:${name}`;
      m.set(key, { mem, rawText: mem.getText(sf), name });
    }
    return m;
  };

  const bMap = baseStmt && ts.isInterfaceDeclaration(baseStmt) ? getMembersMap(baseStmt, currentSf) : new Map();
  const cMap = getMembersMap(currentStmt, currentSf);
  const iMap = getMembersMap(incomingStmt, incomingSf);

  const allKeys = new Set([...cMap.keys(), ...iMap.keys(), ...bMap.keys()]);
  const mergedMembers = [];

  for (const key of allKeys) {
    const b = bMap.get(key);
    const c = cMap.get(key);
    const i = iMap.get(key);

    const cNorm = c ? normalizeText(c.rawText) : null;
    const iNorm = i ? normalizeText(i.rawText) : null;
    const bNorm = b ? normalizeText(b.rawText) : null;

    if (cNorm && iNorm && cNorm === iNorm) {
      mergedMembers.push(c.rawText);
    } else if (bNorm && cNorm && iNorm && cNorm === bNorm && iNorm !== bNorm) {
      mergedMembers.push(i.rawText);
    } else if (bNorm && cNorm && iNorm && iNorm === bNorm && cNorm !== bNorm) {
      mergedMembers.push(c.rawText);
    } else if (cNorm && !bNorm && !iNorm) {
      mergedMembers.push(c.rawText);
    } else if (iNorm && !bNorm && !cNorm) {
      mergedMembers.push(i.rawText);
    } else if (bNorm && !cNorm && iNorm === bNorm) {
      // deleted in current
      continue;
    } else if (bNorm && !iNorm && cNorm === bNorm) {
      // deleted in incoming
      continue;
    } else {
      // Incompatible conflicting edit to property
      const propName = c?.name || i?.name || key;
      return {
        success: false,
        conflict: {
          kind: "interface-member",
          symbol: `${currentStmt.name.text}.${propName}`,
          message: `Conflicting property '${propName}' in interface '${currentStmt.name.text}'`,
          current: c?.rawText,
          incoming: i?.rawText,
          base: b?.rawText
        }
      };
    }
  }

  const resultLines = [
    `${cHeader} {`,
    ...mergedMembers.map((m) => `  ${m.trim()}`),
    `}`
  ];

  return {
    success: true,
    code: resultLines.join("\n")
  };
}

/**
 * 3-Way AST source code merger.
 * @param {string} baseCode
 * @param {string} currentCode
 * @param {string} incomingCode
 * @param {import('./ast-merger.d.mts').MergeOptions} [options={}]
 * @returns {import('./ast-merger.d.mts').MergeResult}
 */
export function mergeSource3Way(baseCode, currentCode, incomingCode, options = {}) {
  const normBase = normalizeText(baseCode);
  const normCurrent = normalizeText(currentCode);
  const normIncoming = normalizeText(incomingCode);

  // Fast path: current equals incoming
  if (normCurrent === normIncoming) {
    return {
      code: currentCode,
      clean: true,
      conflictsCount: 0,
      autoMergedCount: normCurrent !== normBase ? 1 : 0,
      conflicts: []
    };
  }

  // Fast path: current unchanged from base
  if (normCurrent === normBase) {
    return {
      code: incomingCode,
      clean: true,
      conflictsCount: 0,
      autoMergedCount: 1,
      conflicts: []
    };
  }

  // Fast path: incoming unchanged from base
  if (normIncoming === normBase) {
    return {
      code: currentCode,
      clean: true,
      conflictsCount: 0,
      autoMergedCount: 0,
      conflicts: []
    };
  }

  const scriptKind = getScriptKind(options.fileName);
  const fileName = options.fileName || "file.ts";

  const baseSf = ts.createSourceFile(fileName, baseCode, ts.ScriptTarget.Latest, true, scriptKind);
  const currentSf = ts.createSourceFile(fileName, currentCode, ts.ScriptTarget.Latest, true, scriptKind);
  const incomingSf = ts.createSourceFile(fileName, incomingCode, ts.ScriptTarget.Latest, true, scriptKind);

  // 1. Merge imports
  const baseImports = extractImports(baseSf);
  const currentImports = extractImports(currentSf);
  const incomingImports = extractImports(incomingSf);

  const mergedImports = mergeImports3Way(baseImports, currentImports, incomingImports);
  let autoMergedCount = mergedImports.autoMergedCount;

  // 2. Classify top-level statements
  const baseMap = extractTopLevelStatements(baseSf);
  const currentMap = extractTopLevelStatements(currentSf);
  const incomingMap = extractTopLevelStatements(incomingSf);

  const conflicts = [];
  const emittedStatements = [];
  const handledKeys = new Set();

  // Helper to append resolved statement
  const processKey = (key) => {
    if (handledKeys.has(key)) return;
    handledKeys.add(key);

    const b = baseMap.get(key);
    const c = currentMap.get(key);
    const i = incomingMap.get(key);

    const cNorm = c ? normalizeText(c.rawText) : null;
    const iNorm = i ? normalizeText(i.rawText) : null;
    const bNorm = b ? normalizeText(b.rawText) : null;

    // Both current and incoming have identical text
    if (cNorm && iNorm && cNorm === iNorm) {
      emittedStatements.push(c.rawText);
      if (bNorm && cNorm !== bNorm) {
        autoMergedCount++;
      }
      return;
    }

    // Current matches base -> take incoming
    if (cNorm === bNorm) {
      if (iNorm) {
        emittedStatements.push(i.rawText);
        autoMergedCount++;
      }
      return;
    }

    // Incoming matches base -> take current
    if (iNorm === bNorm) {
      if (cNorm) {
        emittedStatements.push(c.rawText);
      }
      return;
    }

    // Current-only addition
    if (cNorm && !bNorm && !iNorm) {
      emittedStatements.push(c.rawText);
      return;
    }

    // Incoming-only addition
    if (iNorm && !bNorm && !cNorm) {
      emittedStatements.push(i.rawText);
      autoMergedCount++;
      return;
    }

    // Deletion: deleted in current, unchanged in incoming
    if (bNorm && !cNorm && iNorm === bNorm) {
      return;
    }

    // Deletion: deleted in incoming, unchanged in current
    if (bNorm && !iNorm && cNorm === bNorm) {
      autoMergedCount++;
      return;
    }

    // Delete vs Modify conflict
    if ((bNorm && !cNorm && iNorm && iNorm !== bNorm) || (bNorm && !iNorm && cNorm && cNorm !== bNorm)) {
      conflicts.push({
        kind: "delete-modify",
        symbol: key,
        message: `Delete vs modify conflict for '${key}'`,
        current: c?.rawText,
        incoming: i?.rawText,
        base: b?.rawText
      });
      emittedStatements.push([
        "<<<<<<< CURRENT",
        c ? c.rawText : "",
        "=======",
        i ? i.rawText : "",
        ">>>>>>> INCOMING"
      ].filter(Boolean).join("\n"));
      return;
    }

    // Both modified or added same key with different text
    if (c && i && c.kind === "interface") {
      const ifaceMerge = tryMergeInterfaceMembers(b?.stmt, c.stmt, i.stmt, currentSf, incomingSf);
      if (ifaceMerge.success && ifaceMerge.code) {
        emittedStatements.push(ifaceMerge.code);
        autoMergedCount++;
        return;
      } else if (ifaceMerge.conflict) {
        conflicts.push(ifaceMerge.conflict);
        emittedStatements.push([
          "<<<<<<< CURRENT",
          c.rawText,
          "=======",
          i.rawText,
          ">>>>>>> INCOMING"
        ].join("\n"));
        return;
      }
    }

    // General declaration conflict
    conflicts.push({
      kind: "declaration",
      symbol: key,
      message: `Concurrent conflicting modifications to '${key}'`,
      current: c?.rawText,
      incoming: i?.rawText,
      base: b?.rawText
    });
    emittedStatements.push([
      "<<<<<<< CURRENT",
      c?.rawText || "",
      "=======",
      i?.rawText || "",
      ">>>>>>> INCOMING"
    ].join("\n"));
  };

  // Preserve ordering: current statements first, then any incoming-only additions
  for (const key of currentMap.keys()) {
    processKey(key);
  }
  for (const key of incomingMap.keys()) {
    processKey(key);
  }

  // Assemble final code
  const parts = [];
  if (mergedImports.code.trim().length > 0) {
    parts.push(mergedImports.code.trim());
  }
  if (emittedStatements.length > 0) {
    parts.push(emittedStatements.join("\n\n"));
  }

  const finalCode = parts.length > 0 ? parts.join("\n\n") + "\n" : "";

  return {
    code: finalCode,
    clean: conflicts.length === 0,
    conflictsCount: conflicts.length,
    autoMergedCount,
    conflicts
  };
}

/**
 * 3-Way file merger.
 * @param {string} baseFilePath
 * @param {string} currentFilePath
 * @param {string} incomingFilePath
 * @param {import('./ast-merger.d.mts').MergeOptions} [options={}]
 * @returns {Promise<import('./ast-merger.d.mts').FileMergeResult>}
 */
export async function mergeFiles3Way(baseFilePath, currentFilePath, incomingFilePath, options = {}) {
  const baseContent = fs.existsSync(baseFilePath) ? await fsp.readFile(baseFilePath, "utf-8") : "";
  const currentContent = fs.existsSync(currentFilePath) ? await fsp.readFile(currentFilePath, "utf-8") : "";
  const incomingContent = fs.existsSync(incomingFilePath) ? await fsp.readFile(incomingFilePath, "utf-8") : "";

  const ext = path.extname(currentFilePath || baseFilePath || incomingFilePath).toLowerCase();
  const isSource = SOURCE_EXTENSIONS.has(ext);

  if (isSource) {
    const res = mergeSource3Way(baseContent, currentContent, incomingContent, {
      fileName: currentFilePath,
      ...options
    });
    return {
      ...res,
      filePath: currentFilePath,
      baseFilePath,
      currentFilePath,
      incomingFilePath
    };
  }

  // Non-source files: Conservative byte/string comparison
  if (currentContent === incomingContent) {
    return {
      code: currentContent,
      clean: true,
      conflictsCount: 0,
      autoMergedCount: currentContent !== baseContent ? 1 : 0,
      conflicts: [],
      filePath: currentFilePath,
      baseFilePath,
      currentFilePath,
      incomingFilePath
    };
  }

  if (currentContent === baseContent) {
    return {
      code: incomingContent,
      clean: true,
      conflictsCount: 0,
      autoMergedCount: 1,
      conflicts: [],
      filePath: currentFilePath,
      baseFilePath,
      currentFilePath,
      incomingFilePath
    };
  }

  if (incomingContent === baseContent) {
    return {
      code: currentContent,
      clean: true,
      conflictsCount: 0,
      autoMergedCount: 0,
      conflicts: [],
      filePath: currentFilePath,
      baseFilePath,
      currentFilePath,
      incomingFilePath
    };
  }

  // Conflicting non-source file
  return {
    code: currentContent,
    clean: false,
    conflictsCount: 1,
    autoMergedCount: 0,
    conflicts: [
      {
        kind: "file",
        filePath: currentFilePath,
        message: `Concurrent differing edits to non-source file '${path.basename(currentFilePath)}'`
      }
    ],
    filePath: currentFilePath,
    baseFilePath,
    currentFilePath,
    incomingFilePath
  };
}

/**
 * Scans a directory recursively for all relative file paths.
 * @param {string} dir
 * @param {string} [baseDir=dir]
 * @returns {Promise<string[]>}
 */
async function collectFiles(dir, baseDir = dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      const sub = await collectFiles(fullPath, baseDir);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }

  return results;
}

/**
 * 3-Way Worktree Merger across entire directories.
 * @param {string} baseDir
 * @param {string} currentDir
 * @param {string} incomingDir
 * @param {import('./ast-merger.d.mts').WorktreeOptions} [options={}]
 * @returns {Promise<import('./ast-merger.d.mts').WorktreeMergeResult>}
 */
export async function mergeWorktrees3Way(baseDir, currentDir, incomingDir, options = {}) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedCurrent = path.resolve(currentDir);
  const resolvedIncoming = path.resolve(incomingDir);
  const resolvedOutput = path.resolve(options.outputDir || currentDir);

  // Protected Zone Invariant: Never write or mutate inside .eval/
  const evalMarker = path.sep + ".eval" + path.sep;
  if (resolvedOutput.includes(evalMarker) || resolvedOutput.endsWith(path.sep + ".eval")) {
    throw new Error("Security Violation: Cannot output merged worktree into protected .eval/ directory.");
  }

  const baseFiles = await collectFiles(resolvedBase);
  const currentFiles = await collectFiles(resolvedCurrent);
  const incomingFiles = await collectFiles(resolvedIncoming);

  const allRelFiles = Array.from(new Set([...baseFiles, ...currentFiles, ...incomingFiles])).sort();

  const fileResults = [];
  const conflicts = [];
  let totalAutoMerged = 0;

  for (const rel of allRelFiles) {
    const bPath = path.join(resolvedBase, rel);
    const cPath = path.join(resolvedCurrent, rel);
    const iPath = path.join(resolvedIncoming, rel);
    const outPath = path.join(resolvedOutput, rel);

    const bExists = fs.existsSync(bPath);
    const cExists = fs.existsSync(cPath);
    const iExists = fs.existsSync(iPath);

    // Case 1: Added only in incoming
    if (!bExists && !cExists && iExists) {
      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      await fsp.copyFile(iPath, outPath);
      totalAutoMerged++;
      continue;
    }

    // Case 2: Added only in current
    if (!bExists && cExists && !iExists) {
      if (resolvedOutput !== resolvedCurrent) {
        await fsp.mkdir(path.dirname(outPath), { recursive: true });
        await fsp.copyFile(cPath, outPath);
      }
      continue;
    }

    // Case 3: Deleted in current, unchanged in incoming
    if (bExists && !cExists && iExists) {
      const bContent = await fsp.readFile(bPath, "utf-8");
      const iContent = await fsp.readFile(iPath, "utf-8");
      if (normalizeText(bContent) === normalizeText(iContent)) {
        // Accept deletion
        if (fs.existsSync(outPath)) {
          await fsp.unlink(outPath);
        }
        continue;
      } else {
        // Delete vs modify conflict
        conflicts.push({
          kind: "delete-modify",
          filePath: rel,
          message: `File '${rel}' was deleted in current but modified in incoming.`
        });
        continue;
      }
    }

    // Case 4: Deleted in incoming, unchanged in current
    if (bExists && cExists && !iExists) {
      const bContent = await fsp.readFile(bPath, "utf-8");
      const cContent = await fsp.readFile(cPath, "utf-8");
      if (normalizeText(bContent) === normalizeText(cContent)) {
        // Accept deletion
        if (fs.existsSync(outPath)) {
          await fsp.unlink(outPath);
        }
        totalAutoMerged++;
        continue;
      } else {
        // Modify vs delete conflict
        conflicts.push({
          kind: "delete-modify",
          filePath: rel,
          message: `File '${rel}' was modified in current but deleted in incoming.`
        });
        continue;
      }
    }

    // Case 5: File exists across all sides
    if (cExists && iExists) {
      const res = await mergeFiles3Way(bPath, cPath, iPath, options);
      fileResults.push(res);
      totalAutoMerged += res.autoMergedCount;
      if (!res.clean) {
        conflicts.push(...res.conflicts);
      }

      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      await fsp.writeFile(outPath, res.code, "utf-8");
    }
  }

  return {
    clean: conflicts.length === 0,
    conflictsCount: conflicts.length,
    autoMergedCount: totalAutoMerged,
    files: fileResults,
    conflicts
  };
}

// CLI Boundary
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  let baseDir = "";
  let currentDir = "";
  let incomingDir = "";
  let outputDir = "";
  let jsonMode = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      jsonMode = true;
    } else if (arg === "--output") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) {
        process.stderr.write("Error: --output requires a directory path argument.\n");
        process.exit(2);
      }
      outputDir = args[++i];
    } else if (!arg.startsWith("-")) {
      if (!baseDir) baseDir = arg;
      else if (!currentDir) currentDir = arg;
      else if (!incomingDir) incomingDir = arg;
    }
  }

  if (!baseDir || !currentDir || !incomingDir) {
    process.stderr.write("Usage: node scripts/harness/ast-merger.mjs <base-dir> <current-dir> <incoming-dir> [--output <out-dir>] [--json]\n");
    process.exit(2);
  }

  mergeWorktrees3Way(baseDir, currentDir, incomingDir, { outputDir: outputDir || currentDir })
    .then((result) => {
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        process.stdout.write(`AST Worktree Merge Result:\n`);
        process.stdout.write(`  Status:       ${result.clean ? "CLEAN" : "CONFLICTED"}\n`);
        process.stdout.write(`  Conflicts:    ${result.conflictsCount}\n`);
        process.stdout.write(`  Auto-Merged:  ${result.autoMergedCount}\n`);
        process.stdout.write(`  Files Merged: ${result.files.length}\n`);
      }
      process.exit(result.clean ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write(`Merge failed: ${err.message}\n`);
      process.exit(2);
    });
}
