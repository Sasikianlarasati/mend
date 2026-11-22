// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// Implements all of SPEC.md: the command line, output and exit codes, safe paths, format detection, line matching
// at three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches
// (section 8), JSON edits (section 9), and order/atomicity (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function serializeFile(fs: FileState): string {
  if (fs.lines.length === 0) return '';
  return fs.lines.join(fs.br) + (fs.final ? fs.br : '');
}

const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

const normLine = (s: string, tier: number): string => {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
};

/** All positions where O occurs in lines at one tier (occurrences may overlap). */
function occurrencesAt(lines: string[], oldLines: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  const k = oldLines.length;
  for (let i = from; i + k <= lines.length; i++) {
    if (eofOnly && i + k - 1 !== lines.length - 1) continue;
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (at or after `from`), or null. */
function findTier(lines: string[], oldLines: string[], strict: boolean, from = 0, eofOnly = false): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrencesAt(lines, oldLines, t, from, eofOnly);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** Tier-2 re-indentation (SPEC.md section 5). Context lines never reach this function. */
function reindentLine(line: string, tier: number, firstFileLine: string, firstOldLine: string): string {
  if (tier !== 2) return line;
  if (line.trim() === '') return line;
  const f = leadWS(firstFileLine);
  const p = leadWS(firstOldLine);
  const w = leadWS(line);
  if (w.startsWith(p)) return f + line.slice(p.length);
  return f + line;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; new: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

type BodyKind = ' ' | '-' | '+' | '\\';
interface BodyLine {
  kind: BodyKind;
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

/** O/N of a hunk or chunk body, plus the context-line map (N index -> O index). */
function splitBody(body: BodyLine[]): { o: string[]; n: string[]; ctx: Map<number, number> } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx = new Map<number, number>();
  for (const b of body) {
    if (b.kind === ' ') {
      ctx.set(n.length, o.length);
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push(b.text);
    }
  }
  return { o, n, ctx };
}

/** True when a `\` line follows the body's last context or `+` line. */
function backslashAfterLast(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === ' ' || body[i]!.kind === '+') last = i;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === '\\';
}

/** Write N over O at pos, context lines taken from the file, tier-2 re-indent applied. */
function spliceLines(fs: FileState, pos: number, oLen: number, n: string[], o: string[], ctx: Map<number, number>, tier: number, finalBreak: boolean): FileState {
  const firstFile = fs.lines[pos] ?? '';
  const firstOld = o[0] ?? '';
  const repl = n.map((line, j) => {
    if (ctx.has(j)) return fs.lines[pos + ctx.get(j)!]!;
    return reindentLine(line, tier, firstFile, firstOld);
  });
  return {
    lines: [...fs.lines.slice(0, pos), ...repl, ...fs.lines.slice(pos + oLen)],
    br: fs.br,
    final: finalBreak,
  };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface Section {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path after `--- ` / `+++ `: text after four chars, up to first tab, spaces removed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  return stripAB(raw);
}

/** Parse one unified section starting at `start` (a `diff --git` line or a `--- ` line). */
function parseUnifiedSection(lines: string[], start: number, gitOld: string | null, gitNew: string | null): { section: Section; next: number } {
  let i = start;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let pairSeen = false;
  let renameOld: string | null = null;
  let renameNew: string | null = null;
  let creation = false;
  let deletion = false;
  if (lines[i]!.startsWith('diff --git ')) {
    i += 1;
  } else {
    pairOld = headerPath(lines[i]!);
    pairNew = headerPath(lines[i + 1]!);
    pairSeen = true;
    i += 2;
  }
  const hunks: Hunk[] = [];
  let inHunks = false;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (inHunks && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (!inHunks && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (!pairSeen) {
        pairOld = headerPath(line);
        pairNew = headerPath(lines[i + 1]!);
        pairSeen = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      inHunks = true;
      const a = Number(m[1]);
      i += 1;
      const body: BodyLine[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          if (bl === '') body.push({ kind: ' ', text: '' });
          else if (bl.startsWith('\\')) body.push({ kind: '\\', text: bl });
          else body.push({ kind: bl[0] as BodyKind, text: bl.slice(1) });
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      hunks.push({ a, body });
      continue;
    }
    if (!inHunks) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        if (renameOld === null) renameOld = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (renameNew === null) renameNew = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        creation = true;
      } else if (line.startsWith('deleted file mode')) {
        deletion = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  let oldPath: string | null;
  let newPath: string | null;
  if (pairSeen) {
    oldPath = pairOld;
    newPath = pairNew;
  } else {
    oldPath = renameOld !== null ? renameOld : gitOld;
    newPath = renameNew !== null ? renameNew : gitNew;
  }
  return { section: { oldPath, newPath, creation, deletion, hunks }, next: i };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const { section, next } = parseUnifiedSection(lines, i, m[1]!, m[2]!);
      edits.push(makeUnifiedEdit(section, strict));
      i = next;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const { section, next } = parseUnifiedSection(lines, i, null, null);
      edits.push(makeUnifiedEdit(section, strict));
      i = next;
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function makeUnifiedEdit(section: Section, strict: boolean): Edit {
  return (tree) => {
    const { oldPath, newPath } = section;
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    const isCreation = oldPath === null || section.creation;
    const isDeletion = newPath === null || section.deletion;
    if (isDeletion && !isCreation) {
      const p = oldPath as string;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (isCreation) {
      const p = newPath as string;
      if (p === null) throw new Fail('unsafe', '/dev/null');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noFinal = false;
      for (const h of section.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k]!.kind === '+') {
            plus.push(h.body[k]!.text);
            noFinal = h.body[k + 1]?.kind === '\\';
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    const p = oldPath as string;
    const target = newPath as string;
    const isMove = p !== target;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (isMove && tree.get(target) !== null) throw new Fail('exists', target);
    let fs = parseFile(before);
    let d = 0;
    for (const hunk of section.hunks) {
      const { o, n, ctx } = splitBody(hunk.body);
      if (o.length === 0) {
        const insertAt = Math.min(hunk.a + d, fs.lines.length);
        const atEnd = insertAt === fs.lines.length;
        const finalBreak = atEnd ? !backslashAfterLast(hunk.body) : fs.final;
        fs = { lines: [...fs.lines.slice(0, insertAt), ...n, ...fs.lines.slice(insertAt)], br: fs.br, final: finalBreak };
        d += n.length;
        continue;
      }
      const found = findTier(fs.lines, o, strict);
      if (!found) throw new Fail('no-match', p);
      const want = hunk.a - 1 + d;
      let best = found.positions[0]!;
      for (const pos of found.positions) {
        if (Math.abs(pos - want) < Math.abs(best - want)) best = pos;
      }
      const touchesEnd = best + o.length === fs.lines.length;
      const finalBreak = touchesEnd ? !backslashAfterLast(hunk.body) : fs.final;
      fs = spliceLines(fs, best, o.length, n, o, ctx, found.tier, finalBreak);
      d += n.length - o.length;
    }
    const out = serializeFile(fs);
    if (isMove) {
      tree.now.set(p, null);
      tree.now.set(target, out);
      tree.moves.push({ old: p, new: target });
    } else {
      tree.now.set(p, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let path: string | null = null;
      for (let j = searchLine - 1; j > prevReplaceEnd; j--) {
        const t = lines[j]!;
        if (blank(t)) continue;
        if (t.trim().startsWith('```')) continue;
        path = t.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = searchLine + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      const oldLines = lines.slice(searchLine + 1, eq);
      const newLines = lines.slice(eq + 1, rep);
      edits.push(makeSREdit(path, oldLines, newLines, strict));
      prevPath = path;
      prevReplaceEnd = rep;
      i = rep + 1;
    } else {
      i += 1;
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const fs = parseFile(text);
    const found = findTier(fs.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const firstFile = fs.lines[pos] ?? '';
    const firstOld = oldLines[0] ?? '';
    const repl = newLines.map((line) => reindentLine(line, found.tier, firstFile, firstOld));
    const out: FileState = {
      lines: [...fs.lines.slice(0, pos), ...repl, ...fs.lines.slice(pos + oldLines.length)],
      br: fs.br,
      final: fs.final,
    };
    tree.now.set(path, serializeFile(out));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      i += 1;
      const content: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          content.push(l.slice(1));
          i += 1;
        } else if (l === '') {
          content.push('');
          i += 1;
        } else if (blank(l)) {
          content.push('');
          i += 1;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      i += 1;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const updateLine = i;
      const path = line.slice('*** Update File:'.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i += 1;
      }
      const chunks: V4AChunk[] = [];
      let current: V4AChunk | null = null;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (blank(l)) {
          if (current !== null) {
            current.body.push({ kind: ' ', text: '' });
          }
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          if (current !== null) chunks.push(current);
          const anchor = l.slice(2).trim();
          current = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          i += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (current === null) throw new Exit2(`error: parse ${i + 1}`);
          current.eof = true;
          chunks.push(current);
          current = null;
          i += 1;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (current === null) current = { anchor: null, body: [], eof: false };
          current.body.push({ kind: l[0] as BodyKind, text: l.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (current !== null) chunks.push(current);
      const lastChunk = chunks[chunks.length - 1];
      if (lastChunk) {
        while (lastChunk.body.length > 0) {
          const b = lastChunk.body[lastChunk.body.length - 1]!;
          if (b.kind === ' ' && b.text === '') lastChunk.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(makeV4AUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function makeV4AUpdateEdit(path: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let fs = parseFile(text);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findTier(fs.lines, [chunk.anchor], strict, cursor, false);
        if (!found) throw new Fail('no-match', path);
        cursor = found.positions[0]! + 1;
      }
      const { o, n, ctx } = splitBody(chunk.body);
      if (o.length === 0) {
        const insertAt = chunk.eof ? fs.lines.length : cursor;
        fs = { lines: [...fs.lines.slice(0, insertAt), ...n, ...fs.lines.slice(insertAt)], br: fs.br, final: fs.final };
        cursor = insertAt + n.length;
        continue;
      }
      const found = findTier(fs.lines, o, strict, cursor, chunk.eof);
      if (!found) throw new Fail('no-match', path);
      const pos = found.positions[0]!;
      fs = spliceLines(fs, pos, o.length, n, o, ctx, found.tier, fs.final);
      cursor = pos + n.length;
    }
    const out = serializeFile(fs);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Driver (SPEC.md sections 1, 2, 10)                                  */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const coveredOld = new Set<string>();
  const coveredNew = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.get(mv.old);
    const wasNew = tree.original(mv.new);
    const nowNew = tree.get(mv.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
      coveredOld.add(mv.old);
      coveredNew.add(mv.new);
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (coveredOld.has(p) || coveredNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    changed.push(p);
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outRows = rows.map((r) => r.text);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
