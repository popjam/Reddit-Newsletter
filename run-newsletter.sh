#!/bin/bash

# Cross-platform Reddit Newsletter Launcher for Linux/macOS
# This script detects the environment and runs the appropriate version

set -euo pipefail

# Get the script directory
SCRIPT_DIR=$(dirname -- "$(readlink -f -- "$0")")
cd "$SCRIPT_DIR" || { echo "Failed to change directory to $SCRIPT_DIR"; exit 1; }

# Function to log with timestamp
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1"
}

# Redirect all output to log file
exec > newsletter-log.txt 2>&1

echo "==============================================="
echo "Reddit Newsletter Generator - Linux/macOS"
log "Started"
echo "Platform: $(uname -s) $(uname -m)"
echo "==============================================="

# Check for Node.js
if ! command -v node >/dev/null 2>&1; then
    echo "❌ ERROR: Node.js not found in PATH"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

# Check for npm
if ! command -v npm >/dev/null 2>&1; then
    echo "❌ ERROR: npm not found in PATH"
    echo "Please ensure npm is properly installed with Node.js"
    exit 1
fi

# Verify we're in the right directory
if [[ ! -f package.json ]]; then
    echo "❌ ERROR: package.json not found"
    echo "Current directory: $(pwd)"
    echo "Please run this script from the project root directory"
    exit 1
fi

# Check for existing process using Node.js script
if node process-checker.js --check >/dev/null 2>&1; then
    status=$?
    if [[ $status -eq 1 ]]; then
        echo "⚠️  WARNING: Newsletter process already running - skipping this execution"
        echo "Use 'ps aux | grep node' to find and kill existing processes if needed"
        exit 0
    fi
fi

echo "✅ All prerequisites checked"
echo "🚀 Starting newsletter generation..."
echo ""

# Run the newsletter generator
if npm start; then
    echo ""
    echo "✅ Newsletter generation completed successfully!"
    echo "Check your email for the generated newsletter"
else
    echo ""
    echo "❌ Newsletter generation failed with error code: $?"
    echo "Check the output above for details"
    exit 1
fi

echo ""
log "Completed successfully"
echo "==============================================="