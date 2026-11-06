// Ставит метку версии на app.js и style.css в index.html, чтобы телефон не держал старую сборку.
import { readFileSync, writeFileSync } from 'node:fs';
const p = 'public/index.html';
writeFileSync(p, readFileSync(p, 'utf8').replace(/\?v=\d+/g, '?v=' + Date.now()));
