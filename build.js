const fs = require('fs');
const header = `// ==UserScript==
// @name         FC SBC Auto
// @namespace    healthbot
// @version      0.1.0
// @description  Анализ клуба и автосборка SBC в EA FC Web App
// @match        https://www.ea.com/ea-sports-fc/ultimate-team/web-app/*
// @match        https://www.ea.com/*/ea-sports-fc/ultimate-team/web-app/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
`;
const core = fs.readFileSync('src/core.js', 'utf8').replace(/^if \(typeof module.*$/m, '').replace('const Core =', 'const FCSBC =');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/fc-sbc-auto.user.js', header + '\n' + core + '\n' + fs.readFileSync('src/userscript.js', 'utf8'));
console.log('dist/fc-sbc-auto.user.js');
