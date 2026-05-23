const fs = require("fs");
const text = fs.readFileSync("src/App.tsx", "utf8");
const lines = text.split("\n");

// Build line/col from char index
function lineCol(idx) {
  let line = 0, col = 0;
  for (let i = 0; i < idx; i++) {
    if (text[i] === '\n') { line++; col = 0; } else { col++; }
  }
  return [line+1, col+1];
}

// Find start of App function (line 509, index 508)
let appStart = 0;
for (let i = 0; i < 508; i++) {
  appStart += lines[i].length + 1;
}

// State machine for brace counting in the App function body
let depth = 1; // App's opening { already counted
let i = appStart + lines[508].length + 1; // start after App line
let state = 'code'; // code | lineComment | blockComment | singleStr | doubleStr | template | templateExpr
const templateStack = []; // track nesting inside ${...}

while (i < text.length) {
  const c = text[i];
  const n = text[i+1];
  
  if (state === 'lineComment') {
    if (c === '\n') state = 'code';
    i++; continue;
  }
  if (state === 'blockComment') {
    if (c === '*' && n === '/') { state = 'code'; i += 2; continue; }
    i++; continue;
  }
  if (state === 'singleStr') {
    if (c === "'" && text[i-1] !== '\\') state = 'code';
    i++; continue;
  }
  if (state === 'doubleStr') {
    if (c === '"' && text[i-1] !== '\\') state = 'code';
    i++; continue;
  }
  if (state === 'template') {
    if (c === '`') { state = templateStack.length ? 'templateExpr' : 'code'; i++; continue; }
    if (c === '$' && n === '{') { templateStack.push('template'); state = 'code'; depth++; i += 2; continue; }
    i++; continue;
  }
  
  // code state
  if (c === '/' && n === '/') { state = 'lineComment'; i += 2; continue; }
  if (c === '/' && n === '*') { state = 'blockComment'; i += 2; continue; }
  if (c === "'") { state = 'singleStr'; i++; continue; }
  if (c === '"') { state = 'doubleStr'; i++; continue; }
  if (c === '`') { state = 'template'; i++; continue; }
  if (c === '{') {
    depth++;
    i++; continue;
  }
  if (c === '}') {
    depth--;
    if (templateStack.length && depth === /* depth when template started */ 0) {
      // This closes a template expression - handled below
    }
    if (templateStack.length > 0) {
      const expectedDepth = templateStack.length; // simplified
    }
    if (depth === 0) {
      const [ln, col] = lineCol(i);
      console.log("App closes at line " + ln + " col " + col);
      for (let k = Math.max(0, ln-4); k <= Math.min(lines.length-1, ln+2); k++) {
        console.log((k+1) + ": " + lines[k]);
      }
      process.exit(0);
    }
    i++; continue;
  }
  i++;
}
console.log("Not found");
