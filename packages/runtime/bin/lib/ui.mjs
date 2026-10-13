// Terminal helpers for the genclass-runtime commands: colours, symbols, a line diff, and questions (yes/no, pick one).
// No dependencies (Node >= 20).

import { createInterface } from "node:readline";

const env = process.env;
const tty = !!process.stdout.isTTY;
export const useColor = env.FORCE_COLOR ? env.FORCE_COLOR !== "0" : !env.NO_COLOR && tty && env.TERM !== "dumb";
const unicode = process.platform !== "win32" || !!env.WT_SESSION || !!env.TERM_PROGRAM;

const wrap = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const sym = {
  ok: unicode ? "✔" : "+",
  arrow: unicode ? "→" : ">",
  dot: unicode ? "•" : "*",
  warn: unicode ? "▲" : "!",
  cross: unicode ? "✖" : "x",
  line: unicode ? "─" : "-",
};

export const out = (s = "") => process.stdout.write(`${s}\n`);
export const err = (s = "") => process.stderr.write(`${s}\n`);

export function banner(title) {
  out();
  out(`  ${c.bold(c.magenta("GenClass Runtime"))} ${c.gray(sym.dot)} ${c.bold(title)}`);
  out();
}

/** "  ✔ Label      value" rows. */
export function row(label, value, mark = c.green(sym.ok)) {
  out(`  ${mark} ${c.bold(label.padEnd(10))} ${value}`);
}

// ------------------------------------------------------------------------------------------------ diff

const splitLines = (s) => (s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/** Line operations [" "|"-"|"+", text] turning a into b (LCS; prefix/suffix only for very large inputs). */
export function diffLines(a, b) {
  const A = splitLines(a);
  const B = splitLines(b);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const ops = A.slice(0, pre).map((l) => [" ", l]);
  const n = a2.length;
  const m = b2.length;
  if (n * m > 4_000_000) {
    for (const l of a2) ops.push(["-", l]);
    for (const l of b2) ops.push(["+", l]);
  } else {
    // dp[i][j] = LCS length of a2[i..] and b2[j..]
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a2[i] === b2[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) {
        ops.push([" ", a2[i]]);
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push(["-", a2[i++]]);
      else ops.push(["+", b2[j++]]);
    }
    while (i < n) ops.push(["-", a2[i++]]);
    while (j < m) ops.push(["+", b2[j++]]);
  }
  for (const l of A.slice(A.length - suf)) ops.push([" ", l]);
  return ops;
}

/** Unified-diff hunks (3 lines of context) as coloured lines. */
export function renderDiff(a, b, context = 3) {
  const ops = diffLines(a, b);
  const idx = [];
  ops.forEach((o, i) => o[0] !== " " && idx.push(i));
  // group changes closer than 2*context lines into one hunk
  const groups = [];
  for (const i of idx) {
    const g = groups[groups.length - 1];
    if (g && i - g[1] <= context * 2 + 1) g[1] = i;
    else groups.push([i, i]);
  }
  const lines = [];
  for (const [first, last] of groups) {
    const start = Math.max(0, first - context);
    const end = Math.min(ops.length, last + context + 1);
    let aLine = 1;
    let bLine = 1;
    for (let x = 0; x < start; x++) {
      if (ops[x][0] !== "+") aLine++;
      if (ops[x][0] !== "-") bLine++;
    }
    const slice = ops.slice(start, end);
    const aCount = slice.filter((o) => o[0] !== "+").length;
    const bCount = slice.filter((o) => o[0] !== "-").length;
    lines.push(c.cyan(`@@ -${aCount ? aLine : aLine - 1},${aCount} +${bCount ? bLine : bLine - 1},${bCount} @@`));
    for (const [op, text] of slice) {
      if (op === "+") lines.push(c.green(`+ ${text}`));
      else if (op === "-") lines.push(c.red(`- ${text}`));
      else lines.push(c.gray(`  ${text}`));
    }
  }
  return lines;
}

/** Prints one file change: a heading and its diff, indented. */
export function printChange(change) {
  const { file, kind } = change;
  const tag = kind === "create" ? c.green("new file") : kind === "delete" ? c.red("delete") : c.yellow("modify");
  out(`  ${c.bold(file)} ${c.gray("(")}${tag}${c.gray(")")}`);
  const lines = renderDiff(change.before ?? "", change.after ?? "");
  for (const l of lines) out(`    ${l}`);
  out();
}

// ------------------------------------------------------------------------------------------------ prompt

/** Whether questions can be asked (stdin is a terminal). */
export const interactive = () => !!process.stdin.isTTY;

// Lines that arrived after the answer to a question (typed ahead, or several answers piped at once): the next
// questions take them first.
const typedAhead = [];
let inputEnded = false;

/**
 * Asks one question and resolves the line typed (trimmed), "" when input ends, or null when stdin is not a
 * terminal. Ctrl-C at a question ends the command (exit code 130); every command asks before it writes.
 */
export async function ask(question) {
  if (!interactive()) return null;
  if (typedAhead.length) {
    const a = typedAhead.shift();
    process.stdout.write(`${question}${a}\n`);
    return a.trim();
  }
  if (inputEnded) {
    process.stdout.write(`${question}\n`);
    return "";
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    let closing = false;
    // lines after the answer in the same chunk of input
    rl.on("line", (line) => typedAhead.push(line));
    rl.question(question, (line) => {
      // piped output (a log): keep the answer on the question's line
      if (!process.stdout.isTTY) process.stdout.write(`${line}\n`);
      answered = true;
      resolve(line.trim());
      setImmediate(() => {
        closing = true;
        rl.close();
      });
    });
    rl.on("SIGINT", () => {
      process.stdout.write("\n");
      err(`  Cancelled.`);
      process.exit(130);
    });
    rl.on("close", () => {
      if (!closing) inputEnded = true;
      if (!answered) {
        answered = true;
        if (!process.stdout.isTTY) process.stdout.write("\n");
        resolve("");
      }
    });
  });
}

/** Asks a yes/no question. Returns null when stdin is not interactive. */
export async function confirm(question, def = true) {
  const hint = def ? "Y/n" : "y/N";
  const answer = await ask(`  ${c.bold(question)} ${c.gray(`(${hint})`)} `);
  if (answer === null) return null;
  const a = answer.toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes";
}

/**
 * Asks to pick one of `labels` (numbered from 1). Returns the index picked, `def` on an empty answer, or null when
 * stdin is not interactive. Asks again (up to 3 times) when the answer is not one of the numbers.
 */
export async function choose(question, labels, def = 0) {
  if (!interactive()) return null;
  out(`  ${c.bold(question)}`);
  labels.forEach((l, i) => out(`    ${c.cyan(String(i + 1).padStart(2))}  ${l}`));
  for (let tries = 0; tries < 3; tries++) {
    const a = await ask(`  ${c.bold("Number")} ${c.gray(`(1-${labels.length}, Enter for ${def + 1})`)} `);
    if (a === null) return null;
    if (a === "") return def;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= labels.length) return n - 1;
    out(`  ${c.yellow(sym.warn)} Type a number from 1 to ${labels.length}.`);
  }
  return null;
}
