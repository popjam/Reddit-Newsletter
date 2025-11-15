#!/usr/bin/env node

import { defaultConfig } from './config.js';

const { version: SCRIPT_VERSION } = defaultConfig;

// Color functions
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
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
  ${colorize('npm start', 'cyan')}              Generate newsletter and send to Kindle
  ${colorize('npm run generate', 'cyan')}       Generate newsletter EPUB only (no sending)
  ${colorize('npm run send', 'cyan')}           Send existing EPUB to Kindle

${colorize('⚙️ Configuration:', 'green')}
  ${colorize('npm run setup', 'cyan')}          Run interactive setup wizard
  ${colorize('npm run reconfigure', 'cyan')}    Modify existing configuration
  ${colorize('npm run config', 'cyan')}         Show current configuration settings
  ${colorize('npm run cover', 'cyan')}          Generate dated book cover manually
  ${colorize('npm run image-quality', 'cyan')}  Configure image compression settings

${colorize('📅 Scheduling:', 'green')}
  ${colorize('npm run schedule-setup', 'cyan')}    Configure automatic daily/weekly generation
  ${colorize('npm run check-schedule', 'cyan')}   View current scheduled tasks
  ${colorize('npm run schedule-enable', 'cyan')}  Enable existing scheduled task
  ${colorize('npm run schedule-disable', 'cyan')} Disable scheduled task (keep settings)
  ${colorize('npm run schedule-delete', 'cyan')}  Delete scheduled task completely

${colorize('📊 Information & Debug:', 'green')}
  ${colorize('npm run stats', 'cyan')}          Show detailed statistics from last run
  ${colorize('npm run verbose', 'cyan')}        Generate with detailed logging output
  ${colorize('npm run check-process', 'cyan')}  Check if newsletter generation is running
  ${colorize('npm run platform-info', 'cyan')} Show system and platform information

${colorize('📋 Examples:', 'yellow')}
  ${colorize('npm start', 'cyan')}                    # Generate and send newsletter
  ${colorize('npm run generate', 'cyan')}             # Only generate EPUB file
  ${colorize('npm run setup', 'cyan')}                # Initial setup or reconfigure
  ${colorize('npm run verbose', 'cyan')}              # Generate with detailed logs
  ${colorize('npm run schedule-setup', 'cyan')}       # Set up daily/weekly automation
  ${colorize('npm run schedule-delete', 'cyan')}      # Remove scheduled task
  ${colorize('npm run stats', 'cyan')}                # View last generation statistics
  ${colorize('npm run image-quality aggressive', 'cyan')} # Set aggressive image compression

${colorize('💡 Getting Started:', 'magenta')}
  1. Run ${colorize('npm run setup', 'cyan')} to configure your email and Reddit preferences
  2. Run ${colorize('npm start', 'cyan')} to generate and send your first newsletter
  3. Optionally, run ${colorize('npm run schedule-setup', 'cyan')} for automatic generation

${colorize('📚 More Help:', 'blue')}
  • Configuration stored in: ${colorize('user-config.json', 'yellow')}
  • Default settings in: ${colorize('config.js', 'yellow')} (do not modify)
  • Setup instructions: ${colorize('SETUP.md', 'yellow')}
  • Project repository: ${colorize('https://github.com/jstriblet/reddit-to-kindle', 'yellow')}

${colorize('══════════════════════════════════════════════════════════', 'blue')}
`);