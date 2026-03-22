const fs = require('fs');
const src = fs.readFileSync('netlify/functions/webhook.js', 'utf8');

let i = 0;
let line = 1;
let col = 0;
let depth = 0;
const stack = [];
let mode = 'code';
let quote = '';
let escape = false;

while (i < src.length) {
  const ch = src[i];
  const next = src[i + 1];

  if (ch === '\n') {
    line += 1;
    col = 0;
  } else {
    col += 1;
  }

  if (mode === 'line-comment') {
    if (ch === '\n') mode = 'code';
    i += 1;
    continue;
  }

  if (mode === 'block-comment') {
    if (ch === '*' && next === '/') {
      mode = 'code';
      i += 2;
      col += 1;
      continue;
    }
    i += 1;
    continue;
  }

  if (mode === 'single-quote' || mode === 'double-quote' || mode === 'template') {
    if (escape) {
      escape = false;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      i += 1;
      continue;
    }

    if (mode === 'single-quote' && ch === "'") {
      mode = 'code';
      i += 1;
      continue;
    }
    if (mode === 'double-quote' && ch === '"') {
      mode = 'code';
      i += 1;
      continue;
    }
    if (mode === 'template') {
      if (ch === '`') {
        mode = 'code';
        i += 1;
        continue;
      }
      if (ch === '$' && next === '{') {
        depth += 1;
        stack.push({ line, col, kind: 'template-expr' });
        i += 2;
        col += 1;
        continue;
      }
    }

    i += 1;
    continue;
  }

  if (ch === '/' && next === '/') {
    mode = 'line-comment';
    i += 2;
    col += 1;
    continue;
  }

  if (ch === '/' && next === '*') {
    mode = 'block-comment';
    i += 2;
    col += 1;
    continue;
  }

  if (ch === "'") {
    mode = 'single-quote';
    i += 1;
    continue;
  }
  if (ch === '"') {
    mode = 'double-quote';
    i += 1;
    continue;
  }
  if (ch === '`') {
    mode = 'template';
    i += 1;
    continue;
  }

  if (ch === '{') {
    depth += 1;
    stack.push({ line, col, kind: 'block' });
  } else if (ch === '}') {
    if (depth === 0) {
      console.log(`Extra closing brace at ${line}:${col}`);
      process.exit(1);
    }
    depth -= 1;
    stack.pop();
  }

  i += 1;
}

console.log(`Final depth: ${depth}`);
if (depth > 0) {
  const last = stack[stack.length - 1];
  console.log(`Last unmatched opening brace near ${last.line}:${last.col} (${last.kind})`);
  process.exit(1);
}
