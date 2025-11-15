#!/usr/bin/env node

import { defaultConfig } from './config.js';

const { version: SCRIPT_VERSION } = defaultConfig;

// Color functions
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function colorize(text, color) {
  return colors[color] + text + colors.reset;
}

console.log(`
${colorize('📰 Reddit to Kindle Newsletter Generator', 'bright')} ${colorize(`v${SCRIPT_VERSION}`, 'cyan')}
${colorize('══════════════════════════════════════════════════════════', 'blue')}

${colorize('🚀 Main Commands:', 'green')}
  ${colorize('npm start', 'cyan')}          Generate and send the newsletter to your Kindle.
  ${colorize('npm run generate', 'cyan')}   Only generate the EPUB file (does not send).
  ${colorize('npm run send', 'cyan')}       Send the most recently created EPUB to your Kindle.

${colorize('⚙️ Configuration & Scheduling:', 'green')}
  ${colorize('npm run setup', 'cyan')}          Run the interactive setup wizard to configure all settings.
  ${colorize('npm run check-schedule', 'cyan')}   Check the status of your automated daily/weekly task.
  ${colorize('npm run image-quality', 'cyan')}  Configure the image compression level (e.g., default, aggressive).

${colorize('💡 Getting Started:', 'magenta')}
  1. Run ${colorize('npm install', 'cyan')} to install all dependencies.
  2. Run ${colorize('npm run setup', 'cyan')} to configure your email, subreddits, and automation.
  3. Run ${colorize('npm start', 'cyan')} to generate and send your first newsletter.

${colorize('📚 More Information:', 'blue')}
  • Your personal settings are stored in: ${colorize('user-config.json', 'yellow')}
  • Detailed setup instructions can be found in: ${colorize('SETUP.md', 'yellow')}
  • The project repository is at: ${colorize('https://github.com/jstriblet/reddit-to-kindle', 'yellow')}

${colorize('══════════════════════════════════════════════════════════', 'blue')}
`);